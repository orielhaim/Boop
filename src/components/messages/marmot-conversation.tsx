import {
  Chat,
  ChatHeader,
  type IMessage,
} from "@kesha-antonov/react-native-chat";
import { randomUUID } from "expo-crypto";
import { router, Stack, useIsFocused } from "expo-router";
import { shareAsync } from "expo-sharing";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState, StyleSheet, View } from "react-native";
import { Action, Empty, Ink, Screen } from "@/components/ui/kit";
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
import { useMarmotError } from "./marmot-group";
import { conversationRoute } from "./marmot-inbox";
import { MarmotLocked } from "./marmot-locked";
import { MarmotLink } from "./marmot-link";
import { MarmotPoll, MarmotPollComposer } from "./marmot-poll";
import { useMarmotWindow } from "./marmot-window";
import { OpenLaterSheet } from "./send-options";
import { useMessageTranslations } from "./use-message-translations";

const locationKind = 24883;

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

export function MarmotConversationScreen({ id }: { id: string }) {
  const { t } = useTranslation(namespaces);
  const { identity, privacy, mediaSdk, lock, marmotViewport } = useLocal();
  const focused = useIsFocused();
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
  const lastRead = useRef<string | undefined>(undefined);
  const draftWrites = useRef(Promise.resolve());
  const peer = snapshot?.peer;
  const avatar = useAvatar(peer);
  const self = identity.publicKey;
  const blocked = Boolean(peer && privacy.isBlocked(peer));
  const title =
    snapshot?.title ||
    (peer ? `${toNpub(peer).slice(0, 15)}…` : t("messages:marmot.group"));
  const deleted = t("messages:marmot.removedMessage");
  const rows = snapshot?.messages;
  const people = snapshot?.identities;
  const messages = useMemo(() => {
    const names = new Map(people?.map((person) => [person.id, person.name]));
    const user = (key: string) => ({ _id: key, name: names.get(key) });
    return (rows ?? [])
      .filter((row) => !privacy.isBlocked(row.sender))
      .map((row): ChatMessage => ({
        _id: row.id,
        direction: row.sender === self ? "outgoing" : "incoming",
        createdAt: row.sentAt * 1_000,
        user: user(row.sender),
        text: row.deleted
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
  }, [rows, people, deleted, privacy, self]);
  useLayoutEffect(() => {
    if (!snapshot || snapshot.invited || !focused || blocked) return;
    return marmotViewport.update(
      id,
      snapshot.messages.filter((row) => visible.has(row.id)),
    );
  }, [id, snapshot, focused, blocked, visible, marmotViewport]);
  const visibleIds = useMemo(() => [...visible], [visible]);
  const translated = useMessageTranslations(
    messages,
    visibleIds,
    kit.locale,
    focused && !snapshot?.invited && !blocked,
  );

  const showError = (reason: unknown) => Alert.alert(translateError(reason));
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
      await marmot.sendMedia(
        id,
        files,
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
        avatar={peer ? { id: peer, uri: avatar } : undefined}
        onBack={() => router.back()}
        onPressTitle={() =>
          peer
            ? router.push({ pathname: "/contact/[key]", params: { key: peer } })
            : router.push(conversationRoute(id, true))
        }
        renderRight={() =>
          peer && !blocked ? (
            <Action
              size="sm"
              onPress={() =>
                router.push({ pathname: "/call/[key]", params: { key: peer } })
              }
            >
              {t("calls:startCall")}
            </Action>
          ) : null
        }
        isTopInsetApplied={false}
      />
      {snapshot.invited ? (
        <MarmotInvitation id={id} busy={busy} setBusy={setBusy} />
      ) : (
        <>
          {snapshot.hasMoreAfter && (
            <Action size="sm" onPress={() => void page("newer")}>
              {t("messages:latest")}
            </Action>
          )}
          <View style={styles.chat}>
            <Chat<ChatMessage>
              {...kit}
              messages={translated.displayed}
              user={{ _id: self }}
              isGroupChat={!peer}
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
                onPress: (target) =>
                  void window?.jump(String(target._id)).catch(showError),
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
                  <MarmotAttachments group={id} row={row} />
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
  busy,
  setBusy,
}: {
  id: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy, db } = useLocal();
  const translateError = useMarmotError();
  const [inviter, setInviter] = useState<string | null>();
  useEffect(() => {
    let active = true;
    void marmot
      .groupDetails(id)
      .then((group) => {
        if (active) setInviter(group.inviter ?? null);
      })
      .catch(() => {
        if (active) setInviter(null);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const blocked = inviter ? privacy.isBlocked(inviter) : false;
  const allowed = inviter && privacy.messagePermission(inviter) !== "blocked";
  const name = inviter
    ? (contactByKey(db, inviter).get()?.name ?? toNpub(inviter))
    : null;
  function respond(accept: boolean) {
    if (
      busy ||
      (accept && (!inviter || privacy.messagePermission(inviter) === "blocked"))
    )
      return;
    setBusy(true);
    void marmot
      .respondToInvitation(id, accept)
      .then(() => {
        if (!accept) router.back();
      })
      .catch((reason) => Alert.alert(translateError(reason)))
      .finally(() => setBusy(false));
  }
  return (
    <View style={styles.invitation}>
      <Ink>
        {t(
          blocked
            ? "messages:marmot.blocked"
            : "messages:marmot.inviteRequired",
        )}
      </Ink>
      {name && (
        <Ink kind="caption">{t("messages:marmot.invitedBy", { name })}</Ink>
      )}
      <Action disabled={busy || !allowed} onPress={() => respond(true)}>
        {t("messages:marmot.approve")}
      </Action>
      <Action disabled={busy} onPress={() => respond(false)}>
        {t("messages:marmot.decline")}
      </Action>
    </View>
  );
}

function MarmotAttachments({
  group,
  row,
}: {
  group: string;
  row: MarmotMessage;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy } = useLocal();
  const [busy, setBusy] = useState<number>();
  async function open(index: number) {
    if (!row.sourceId || privacy.isBlocked(row.sender) || busy !== undefined)
      return;
    const source = row.sourceId;
    setBusy(index);
    try {
      let file = await marmot.openAttachment(group, row.id, source, index);
      if (!file) {
        if (privacy.isBlocked(row.sender)) return;
        await marmot.downloadAttachment(group, row.id, source, index);
        file = await marmot.openAttachment(group, row.id, source, index);
      }
      if (!file) throw new Error("MediaUnavailable");
      try {
        if (!privacy.isBlocked(row.sender))
          await shareAsync(`file://${file.path}`, { mimeType: file.type });
      } finally {
        await marmot.releaseAttachment(file.lease);
      }
    } catch {
      Alert.alert(t("messages:mediaOpenFailed"));
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <View style={styles.media}>
      {row.attachments.map((item) => (
        <View key={item.index}>
          <Ink kind="caption">{item.name}</Ink>
          <Action
            size="sm"
            disabled={busy !== undefined}
            onPress={() => void open(item.index)}
          >
            {busy === item.index
              ? t("common:checking")
              : t("messages:marmot.download")}
          </Action>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chat: { flex: 1 },
  invitation: { padding: space.md, gap: space.sm },
  media: { padding: space.sm, gap: space.xs },
});
