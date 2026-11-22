import {
  Chat,
  type ChatHandle,
  ChatHeader,
  type IMessage,
} from "@kesha-antonov/react-native-chat";
import { randomUUID } from "expo-crypto";
import { Image } from "expo-image";
import { router, Stack, useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState, StyleSheet, View } from "react-native";
import { Action, Avatar, Empty, Ink, Screen } from "@/components/ui/kit";
import { useAvatar } from "@/core/avatars/use-avatar";
import { toNpub } from "@/core/identity/keys";
import { locationFromText, locationText } from "@/core/messaging/location";
import {
  encryptTimeLock,
  timeLockKind,
} from "@/core/messaging/special-messages/timelock";
import {
  marmot,
  type MarmotMessage,
  type MarmotUpload,
} from "@/core/marmot/native";
import { contactByKey } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import { MarmotAttachments } from "./marmot-attachments";
import { useMarmotError } from "./marmot-group";
import { conversationRoute } from "./marmot-inbox";
import { MarmotLocked } from "./marmot-locked";
import { MarmotLink } from "./marmot-link";
import {
  ConversationSearch,
  ForwardMessage,
  MessageEditHistory,
} from "./marmot-message-tools";
import { MarmotPoll, MarmotPollComposer } from "./marmot-poll";
import { useMarmotWindow } from "./marmot-window";
import { OpenLaterSheet } from "./send-options";
import { useMessageTranslations } from "./use-message-translations";
import { useMarmotGroupAvatar } from "./use-marmot-group-avatar";

const locationKind = 24883;
const systemLabels = {
  member_added: "messages:marmot.eventMemberAdded",
  member_removed: "messages:marmot.eventMemberRemoved",
  member_left: "messages:marmot.eventMemberLeft",
  admin_added: "messages:marmot.eventAdminAdded",
  admin_removed: "messages:marmot.eventAdminRemoved",
  group_renamed: "messages:marmot.eventGroupRenamed",
  group_avatar_changed: "messages:marmot.eventGroupAvatar",
  disappearing_timer_changed: "messages:marmot.eventRetention",
  group_disbanded: "messages:marmot.eventDisbanded",
} as const;
function systemLabel(type: string) {
  if (Object.hasOwn(systemLabels, type))
    return systemLabels[type as keyof typeof systemLabels];
  return "messages:marmot.eventGroupChanged";
}
function subscribeForeground(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}
const isForeground = () => AppState.currentState === "active";

export function OpenMarmotDirect({ peer }: { peer: string }) {
  const { t } = useTranslation(namespaces);
  const { marmotSession, identity, privacy } = useLocal();
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<{ reason: unknown }>();
  const translateError = useMarmotError();
  const allowed = peer !== identity.publicKey && !privacy.isBlocked(peer);
  useEffect(() => {
    if (!allowed) return;
    let active = true;
    void marmotSession
      .ready()
      .then(() => marmot.startDirect(peer))
      .then((group) => {
        if (active) router.replace(conversationRoute(group));
      })
      .catch((reason) => {
        if (active) setError({ reason });
      });
    return () => {
      active = false;
    };
  }, [allowed, marmotSession, peer, retry]);
  const title = allowed
    ? t("messages:marmot.newDirect")
    : t("messages:unavailable");
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title }} />
      <Empty
        detail=""
        icon="chat"
        title={
          error
            ? translateError(error.reason)
            : allowed
              ? t("common:checking")
              : title
        }
      >
        {error && (
          <Action
            onPress={() => {
              setError(undefined);
              setRetry((value) => value + 1);
            }}
          >
            {t("common:retry")}
          </Action>
        )}
      </Empty>
    </Screen>
  );
}

type ChatMessage = IMessage & {
  _id: string;
  row?: MarmotMessage;
  direction: "incoming" | "outgoing";
  originalText?: string;
};

function localUpload(uri: string, name: string, type: string): MarmotUpload {
  if (uri.startsWith("/")) return { path: uri, name, type };
  if (!uri.startsWith("file:///")) throw new Error("InvalidMediaPath");
  return { path: decodeURIComponent(uri.slice(7)), name, type };
}

export function MarmotConversationScreen({
  id,
  initialPanel,
}: {
  id: string;
  initialPanel?: "search" | "media";
}) {
  const { t } = useTranslation(namespaces);
  const { identity, privacy, mediaSdk, lock, marmotViewport, chatPreferences } =
    useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const focused = useIsFocused();
  const foreground = useSyncExternalStore(subscribeForeground, isForeground);
  const open = useCallback(() => marmot.openConversation(id), [id]);
  const { snapshot, window, error, retry } = useMarmotWindow(open);
  const kit = useChatAppearance(true);
  const translateError = useMarmotError();
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [paging, setPaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<string>();
  const [later, setLater] = useState(false);
  const [poll, setPoll] = useState(false);
  const [laterError, setLaterError] = useState<string>();
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [panel, setPanel] = useState<
    "search" | "media" | "edits" | "forward" | null
  >(initialPanel ?? null);
  const [selected, setSelected] = useState<MarmotMessage>();
  const [jump, setJump] = useState<string>();
  const [highlight, setHighlight] = useState("");
  const [pinOffset, setPinOffset] = useState(0);
  const chatRef = useRef<ChatHandle | null>(null);
  const lastRead = useRef<string | undefined>(undefined);
  const draftWrites = useRef(Promise.resolve());
  const peer = snapshot?.peer;
  const avatar = useAvatar(snapshot?.invited ? undefined : peer);
  const groupAvatar = useMarmotGroupAvatar(
    id,
    snapshot?.invited ? undefined : snapshot?.image,
  );
  const self = identity.publicKey;
  const blocked = Boolean(peer && privacy.isBlocked(peer));
  const title = snapshot?.invited
    ? t("messages:marmot.invitations")
    : snapshot?.title ||
      (peer ? `${toNpub(peer).slice(0, 15)}…` : t("messages:marmot.group"));
  const deleted = t("messages:marmot.removedMessage");
  const rows = snapshot?.messages;
  const people = snapshot?.identities;
  const pins = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.pinned(id),
  );
  const hidden = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.hidden(id),
  );
  const blockedKeys = privacy.blockedKeys().join(",");
  const messages = useMemo(() => {
    const blocked = new Set(blockedKeys.split(","));
    const omitted = new Set(hidden);
    const names = new Map(people?.map((person) => [person.id, person.name]));
    const user = (key: string) => ({ _id: key, name: names.get(key) });
    return (rows ?? [])
      .filter((row) => !blocked.has(row.sender) && !omitted.has(row.id))
      .map((row): ChatMessage => ({
        _id: row.id,
        direction: row.sender === self ? "outgoing" : "incoming",
        createdAt: row.sentAt * 1_000,
        user: user(row.sender),
        text: row.systemType
          ? t(systemLabel(row.systemType))
          : row.deleted
            ? deleted
            : row.eventKind === timeLockKind ||
                row.eventKind === locationKind ||
                row.poll
              ? ""
              : row.text,
        location:
          row.eventKind === locationKind && !row.deleted
            ? locationFromText(row.text)
            : undefined,
        pending: row.sender === self && !row.confirmed && !row.invalidated,
        sent: row.sender === self && row.confirmed,
        isFailed: row.sender === self && row.invalidated,
        isEdited: row.edited,
        isPinned: pins.includes(row.id),
        system: Boolean(row.systemType),
        replyMessage: row.replyPreview
          ? {
              _id: row.replyPreview.id,
              text: row.replyPreview.text,
              user: user(row.replyPreview.sender),
            }
          : undefined,
        reactions: row.reactions.map((reaction) => ({
          emoji: reaction.emoji,
          userIds:
            reaction.own && !reaction.users.includes(self)
              ? [...reaction.users, self]
              : reaction.users,
        })),
        row,
      }))
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }, [rows, people, deleted, blockedKeys, hidden, pins, self, t]);
  const locallyInitiated = Boolean(
    peer &&
    rows?.some(
      (row) =>
        row.token && row.sender === self && row.confirmed && !row.invalidated,
    ),
  );
  useEffect(() => {
    if (peer && locallyInitiated && !blocked)
      privacy.noteInitiatedMessage(peer);
  }, [peer, locallyInitiated, blocked, privacy]);
  useLayoutEffect(() => {
    if (!snapshot || snapshot.invited || !focused || !foreground || blocked)
      return;
    return marmotViewport.update(
      id,
      snapshot.messages.filter(
        (row) => visible.has(row.id) && !hidden.includes(row.id),
      ),
    );
  }, [
    id,
    snapshot,
    focused,
    foreground,
    blocked,
    visible,
    hidden,
    marmotViewport,
  ]);
  const visibleIds = useMemo(() => [...visible], [visible]);
  const translated = useMessageTranslations(
    messages,
    visibleIds,
    kit.locale,
    focused && !snapshot?.invited && !blocked,
  );

  const showError = (reason: unknown) => Alert.alert(translateError(reason));
  function moveTo(message: string, query = "") {
    if (hidden.includes(message)) return;
    setPanel(null);
    setHighlight(query);
    setJump(message);
    if (!messages.some((row) => row._id === message)) {
      void window?.jump(message).catch((reason) => {
        setJump(undefined);
        showError(reason);
      });
    }
  }
  useEffect(() => {
    if (!jump || !messages.some((row) => row._id === jump)) return;
    const task = requestAnimationFrame(() => {
      chatRef.current?.scrollToMessage(jump, { isHighlighted: true });
      setJump(undefined);
    });
    return () => cancelAnimationFrame(task);
  }, [jump, messages]);
  const canSend = Boolean(snapshot?.canSend && !blocked && !snapshot.invited);
  const canDispatch = () =>
    canSend &&
    focused &&
    AppState.currentState === "active" &&
    !lock.getState().locked &&
    !(peer && privacy.isBlocked(peer));
  const run = (fn: () => Promise<unknown>) => {
    if (canDispatch()) void fn().catch(showError);
  };
  function saveDraft(text: string, target: string | null) {
    setComposer(text);
    if (!canDispatch()) return;
    draftWrites.current = draftWrites.current
      .then(() => marmot.saveDraft(id, text, target))
      .catch(() => undefined);
  }
  const onVisible = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: { item: ChatMessage; isViewable: boolean }[];
    }) => {
      const items = viewableItems
        .filter(({ isViewable }) => isViewable)
        .map(({ item }) => item);
      setVisible(new Set(items.map(({ _id }) => _id)));
      const latest = items.reduce<ChatMessage | undefined>(
        (selected, item) =>
          !selected || Number(item.createdAt) > Number(selected.createdAt)
            ? item
            : selected,
        undefined,
      );
      if (
        !latest?.row ||
        latest._id === lastRead.current ||
        !focused ||
        AppState.currentState !== "active" ||
        lock.getState().locked
      )
        return;
      lastRead.current = latest._id;
      void marmot.markRead(id, latest._id).catch(() => {
        lastRead.current = undefined;
      });
    },
    [focused, id, lock],
  );
  async function page(direction: "older" | "newer") {
    if (!window || paging) return;
    setPaging(true);
    try {
      await window.page(direction);
    } catch (reason) {
      showError(reason);
    } finally {
      setPaging(false);
    }
  }

  function sendMedia(files: MarmotUpload[], caption?: string) {
    if (!canSend || !files.length) return;
    const server = mediaSdk.configured("attachment")[0]?.origin;
    if (!server) {
      Alert.alert(t("messages:mediaUploadFailed"));
      return;
    }
    const target = reply?._id ?? null;
    run(async () => {
      const prepared = await Promise.all(
        files.map(async (file) => {
          if (file.thumbhash || !file.type.startsWith("image/")) return file;
          try {
            const image = await Image.loadAsync(`file://${file.path}`, {
              maxWidth: 96,
              maxHeight: 96,
            });
            return {
              ...file,
              thumbhash: await Image.generateThumbhashAsync(image),
            };
          } catch {
            return file;
          }
        }),
      );
      if (
        !canDispatch() ||
        mediaSdk.configured("attachment")[0]?.origin !== server
      )
        return;
      await marmot.sendMedia(
        id,
        prepared,
        caption?.trim() || null,
        randomUUID(),
        server,
        target,
      );
      setReply(null);
    });
  }

  async function sendLater(time: number) {
    const text = (composer ?? snapshot?.draft?.text ?? "").trim();
    if (!canDispatch() || !text || busy) return;
    setBusy(true);
    setLaterError(undefined);
    try {
      const encrypted = await encryptTimeLock(text, time);
      if (!canDispatch()) return;
      await marmot.sendSpecial(
        id,
        timeLockKind,
        JSON.stringify(encrypted),
        reply?._id ?? null,
      );
      saveDraft("", null);
      setReply(null);
      setLater(false);
    } catch {
      setLaterError(t("messages:openSendError"));
    } finally {
      setBusy(false);
    }
  }

  if (error || !snapshot)
    return (
      <Screen>
        <Stack.Screen options={{ title }} />
        <Empty
          detail=""
          icon="chat"
          title={
            error ? t("messages:marmot.accountError") : t("common:checking")
          }
        >
          {error && <Action onPress={retry}>{t("common:retry")}</Action>}
        </Empty>
      </Screen>
    );

  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatHeader
        {...kit}
        title={title}
        avatar={
          snapshot.invited
            ? undefined
            : { id: peer ?? id, uri: peer ? avatar : groupAvatar }
        }
        onBack={() => router.back()}
        onPressTitle={
          snapshot.invited
            ? undefined
            : () =>
                peer
                  ? router.push({
                      pathname: "/contact/[key]",
                      params: { key: peer },
                    })
                  : router.push(conversationRoute(id, "details"))
        }
        renderRight={() =>
          peer && !blocked && !snapshot.invited ? (
            <Action
              size="sm"
              onPress={() =>
                router.push({ pathname: "/call/[key]", params: { key: peer } })
              }
            >
              {t("calls:startCall")}
            </Action>
          ) : !peer && !snapshot.invited && snapshot.canSend ? (
            <Action
              size="sm"
              onPress={() => router.push(conversationRoute(id, "call"))}
            >
              {t("calls:startCall")}
            </Action>
          ) : null
        }
        isTopInsetApplied={false}
      />
      {snapshot.invited ? (
        <MarmotInvitation
          id={id}
          direct={Boolean(peer)}
          busy={busy}
          setBusy={setBusy}
        />
      ) : (
        <>
          <View style={styles.tools}>
            <Action size="sm" onPress={() => setPanel("search")}>
              {t("messages:marmot.searchConversation")}
            </Action>
            {peer && !blocked && (
              <Action
                size="sm"
                onPress={() => router.push(conversationRoute(id, "details"))}
              >
                {t("messages:marmot.conversationDetails")}
              </Action>
            )}
            {!blocked && (
              <Action
                size="sm"
                onPress={() =>
                  void marmot
                    .markUnread(id)
                    .then(() => router.back())
                    .catch(showError)
                }
              >
                {t("messages:marmot.markUnread")}
              </Action>
            )}
            {pins.length > 0 && (
              <Action
                size="sm"
                onPress={() => {
                  const position = pinOffset % pins.length;
                  const message = pins[position];
                  if (message) moveTo(message);
                  setPinOffset(position + 1);
                }}
              >
                {t(
                  pins.length === 1
                    ? "messages:pinnedMessage"
                    : "messages:pinnedMessages",
                )}
              </Action>
            )}
          </View>
          {(panel === "search" || panel === "media") && (
            <ConversationSearch
              group={id}
              media={panel === "media"}
              onSelect={moveTo}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === "edits" && selected && (
            <MessageEditHistory
              group={id}
              message={selected.id}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === "forward" && selected && (
            <ForwardMessage
              group={id}
              row={selected}
              canDispatch={canDispatch}
              onClose={() => setPanel(null)}
            />
          )}
          {snapshot.hasMoreAfter && (
            <Action size="sm" onPress={() => void page("newer")}>
              {t("messages:latest")}
            </Action>
          )}
          <View style={styles.chat}>
            <Chat<ChatMessage>
              {...kit}
              messages={translated.displayed}
              chatRef={chatRef}
              highlightText={highlight}
              user={{ _id: self }}
              isGroupChat={!peer}
              renderAvatar={
                !peer
                  ? ({ currentMessage }) => (
                      <Avatar
                        publicKey={String(currentMessage.user._id)}
                        name={currentMessage.user.name ?? t("common:unknown")}
                        size="sm"
                      />
                    )
                  : undefined
              }
              forceRTL={kit.rtl}
              firstUnreadMessageId={snapshot.firstUnread ?? undefined}
              initialText={snapshot.draft?.text}
              text={composer}
              onDraftChange={(text) => saveDraft(text, reply?._id ?? null)}
              listProps={{ onViewableItemsChanged: onVisible }}
              attachments={{
                isEnabled: canSend,
                isGalleryGridEnabled: false,
                onPick: (attachments, { caption }) => {
                  try {
                    const files: MarmotUpload[] = [];
                    for (const item of attachments) {
                      if (item.type === "location") {
                        run(() =>
                          marmot.sendSpecial(
                            id,
                            locationKind,
                            locationText(item),
                            reply?._id ?? null,
                          ),
                        );
                      } else if (item.type === "file") {
                        files.push(
                          localUpload(
                            item.uri,
                            item.name,
                            item.mimeType ?? "application/octet-stream",
                          ),
                        );
                      } else {
                        const mime =
                          item.type === "image" ? "image/jpeg" : "video/mp4";
                        const name =
                          item.type === "image" ? "image.jpg" : "video.mp4";
                        const file = localUpload(
                          item.uri,
                          item.fileName ?? name,
                          item.mimeType ?? mime,
                        );
                        if (item.width && item.height)
                          file.dimensions = `${item.width}x${item.height}`;
                        files.push(file);
                      }
                    }
                    sendMedia(files, caption);
                  } catch (reason) {
                    showError(reason);
                  }
                  return null;
                },
              }}
              loadEarlierMessagesProps={{
                isAvailable: snapshot.hasMoreBefore,
                isLoading: paging,
                onPress: () => void page("older"),
              }}
              renderInputToolbar={
                canSend
                  ? undefined
                  : () =>
                      blocked ? <Ink>{t("messages:marmot.blocked")}</Ink> : null
              }
              onSend={
                canSend
                  ? (batch) => {
                      for (const item of batch) {
                        if (item.audio || item.video) {
                          try {
                            sendMedia(
                              [
                                item.audio
                                  ? localUpload(
                                      item.audio,
                                      "voice.m4a",
                                      "audio/mp4",
                                    )
                                  : localUpload(
                                      item.video ?? "",
                                      item.videoNote
                                        ? "video-note.mp4"
                                        : "video.mp4",
                                      "video/mp4",
                                    ),
                              ],
                              item.text,
                            );
                          } catch (reason) {
                            showError(reason);
                          }
                        } else if (item.text.trim()) {
                          const text = item.text.trim();
                          const target = reply?._id ?? null;
                          run(async () => {
                            await marmot.sendText(
                              id,
                              text,
                              randomUUID(),
                              target,
                            );
                            setReply(null);
                          });
                        }
                      }
                    }
                  : undefined
              }
              onEditMessage={
                canSend
                  ? (row, text) =>
                      run(() => marmot.editMessage(id, row._id, text))
                  : undefined
              }
              onDeleteMessage={
                canSend
                  ? (row) => run(() => marmot.deleteMessage(id, row._id))
                  : undefined
              }
              onPinMessage={(message) => {
                if (
                  message.row &&
                  !message.row.deleted &&
                  !message.row.systemType
                ) {
                  chatPreferences.setPin(id, message._id, !message.isPinned);
                }
              }}
              onForwardMessage={(message) => {
                setSelected(message.row);
                setPanel("forward");
              }}
              messageActions={(message, defaults) => {
                const row = message.row;
                if (!row || row.deleted || row.systemType) return [];
                const forwardable = [9, 1111, locationKind].includes(
                  row.eventKind,
                );
                const textEditable =
                  (row.eventKind === 9 || row.eventKind === 1111) &&
                  !row.attachments.length;
                const actions = defaults.filter(
                  (action) =>
                    (action.key !== "forward" || forwardable) &&
                    (action.key !== "edit" || textEditable) &&
                    (action.key !== "delete" || row.sender === self),
                );
                if (row.edited)
                  actions.push({
                    key: "editHistory",
                    label: t("messages:editHistory"),
                    onPress() {
                      setSelected(row);
                      setPanel("edits");
                    },
                  });
                actions.push({
                  key: "deleteLocal",
                  label: t("messages:marmot.removeForMe"),
                  destructive: true,
                  onPress: () => chatPreferences.hide(id, row.id),
                });
                return actions;
              }}
              onRetryMessage={
                canSend
                  ? () => run(() => marmot.retryConversation(id))
                  : undefined
              }
              reply={{
                isEnabled: canSend,
                message: reply,
                onReply: setReply,
                onClear: () => setReply(null),
                onPress: (target) => moveTo(String(target._id)),
              }}
              reactions={{
                isEnabled: canSend,
                onReactionPress: (row, emoji) => {
                  const own = row.row?.reactions.some(
                    (reaction) => reaction.emoji === emoji && reaction.own,
                  );
                  run(() =>
                    marmot.reactToMessage(id, row._id, emoji, Boolean(own)),
                  );
                },
              }}
              renderCustomView={({ currentMessage }) => {
                const row = currentMessage?.row;
                if (!row || row.deleted) return null;
                if (row.poll)
                  return (
                    <MarmotPoll group={id} row={row} canSend={canDispatch} />
                  );
                if (row.eventKind === timeLockKind)
                  return (
                    <MarmotLocked
                      key={row.id}
                      message={row.id}
                      content={row.text}
                      active={
                        focused &&
                        visible.has(row.id) &&
                        !blocked &&
                        !privacy.isBlocked(row.sender)
                      }
                      rtl={kit.rtl}
                    />
                  );
                return row.attachments.length ? (
                  focused && foreground && !blocked ? (
                    <MarmotAttachments group={id} row={row} />
                  ) : null
                ) : row.eventKind === 9 || row.eventKind === 1111 ? (
                  <>
                    <MarmotLink
                      group={id}
                      id={row.id}
                      body={row.text}
                      eligible={
                        focused &&
                        visible.has(row.id) &&
                        !blocked &&
                        !privacy.isBlocked(row.sender)
                      }
                    />
                    {currentMessage.originalText && (
                      <Action
                        size="sm"
                        variant="ghost"
                        onPress={() => translated.toggleOriginal(row.id)}
                      >
                        {t(
                          currentMessage.text === currentMessage.originalText
                            ? "translation:showTranslation"
                            : "translation:showOriginal",
                        )}
                      </Action>
                    )}
                  </>
                ) : null;
              }}
              audioRecording={canSend}
              videoRecording={canSend}
            />
          </View>
          {canSend && (composer ?? snapshot.draft?.text)?.trim() && (
            <Action size="sm" onPress={() => setLater(true)}>
              {t("messages:openLater")}
            </Action>
          )}
          {!peer && canSend && (
            <Action size="sm" onPress={() => setPoll(true)}>
              {t("messages:marmot.newPoll")}
            </Action>
          )}
          {poll && (
            <MarmotPollComposer
              group={id}
              cancel={() => setPoll(false)}
              canSend={canDispatch}
            />
          )}
          {later && (
            <OpenLaterSheet
              open
              onCancel={() => setLater(false)}
              onSend={(time) => void sendLater(time)}
              busy={busy}
              error={laterError}
              colorScheme={kit.colorScheme}
              rtl={kit.rtl}
            />
          )}
        </>
      )}
    </Screen>
  );
}

function MarmotInvitation({
  id,
  direct,
  busy,
  setBusy,
}: {
  id: string;
  direct: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy, db } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const translateError = useMarmotError();
  const [invitation, setInvitation] = useState<{
    inviter?: string | null;
    name: string;
  }>();
  useEffect(() => {
    let active = true;
    void marmot
      .groupDetails(id)
      .then((group) => {
        if (active) setInvitation(group);
      })
      .catch(() => {
        if (active) setInvitation({ name: "" });
      });
    return () => {
      active = false;
    };
  }, [id]);
  const inviter = invitation?.inviter;
  const permission = inviter ? privacy.messagePermission(inviter) : undefined;
  const allowed = permission === "allow" || permission === "request";
  const name =
    inviter && allowed
      ? (contactByKey(db, inviter).get()?.name ?? toNpub(inviter))
      : null;
  function respond(accept: boolean) {
    if (busy) return;
    const current = inviter ? privacy.messagePermission(inviter) : undefined;
    if (accept && current !== "allow" && current !== "request") return;
    setBusy(true);
    void marmot
      .respondToInvitation(id, accept)
      .then(() => {
        if (accept && direct && inviter) privacy.approveInvitation(inviter);
        else if (!accept) router.back();
      })
      .catch((reason) => Alert.alert(translateError(reason)))
      .finally(() => setBusy(false));
  }
  return (
    <View style={styles.invitation}>
      <Ink>
        {t(
          permission === "blocked"
            ? "messages:marmot.blocked"
            : permission === "reject"
              ? "messages:marmot.inviteFiltered"
              : "messages:marmot.inviteRequired",
        )}
      </Ink>
      {allowed && invitation?.name && <Ink kind="title">{invitation.name}</Ink>}
      {name && (
        <Ink kind="caption">{t("messages:marmot.invitedBy", { name })}</Ink>
      )}
      <Action disabled={busy || !allowed} onPress={() => respond(true)}>
        {t("messages:marmot.approve")}
      </Action>
      <Action disabled={busy} onPress={() => respond(false)}>
        {t("messages:marmot.decline")}
      </Action>
      {inviter && permission !== "blocked" && (
        <Action
          disabled={busy}
          onPress={() => {
            privacy.block(inviter);
            respond(false);
          }}
        >
          {t("messages:marmot.blockInviter")}
        </Action>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chat: { flex: 1 },
  tools: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.xs,
    paddingHorizontal: space.sm,
  },
  invitation: { padding: space.md, gap: space.sm },
});
