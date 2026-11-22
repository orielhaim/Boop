import {
  Chat,
  type ChatHandle,
  ChatHeader,
  Composer,
  type IMessage,
  InputToolbar,
  MessageText,
} from "@kesha-antonov/react-native-chat";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router, Stack, useIsFocused } from "expo-router";
import {
  type ComponentRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AppState,
  BackHandler,
  Image as BackgroundImage,
  Keyboard,
  Pressable,
  StyleSheet,
  type TextInput,
  View,
} from "react-native";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { ActionMenu } from "@/components/ui/action-menu";
import {
  Action,
  Avatar,
  Empty,
  Icon,
  IconButton,
  Ink,
  Screen,
  Search,
} from "@/components/ui/kit";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { useAvatar } from "@/core/avatars/use-avatar";
import { groupCallKind } from "@/core/calling/group-presence";
import { toNpub } from "@/core/identity/keys";
import { locationFromText, locationText } from "@/core/messaging/location";
import {
  editMentionText,
  insertMention,
  mentionAt,
  mentionWireOffset,
  projectMentions,
} from "@/core/messaging/mentions";
import {
  encryptTimeLock,
  timeLockKind,
} from "@/core/messaging/special-messages/timelock";
import { createAttachmentPresentation } from "@/core/marmot/attachment-presentation";
import {
  marmot,
  type MarmotGroupDetails,
  type MarmotMessage,
  type MarmotUpload,
} from "@/core/marmot/native";
import {
  applyAttachmentMetadata,
  pendingMediaDraft,
} from "@/core/marmot/media-send";
import { sendMarmotAttachment } from "@/core/marmot/send-attachment";
import { contactByKey } from "@/db/queries";
import { removeOpenedMessage } from "@/db/open-later";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { radius, space } from "@/theme";
import { conversationMaterials, useChatAppearance } from "./appearance";
import { MarmotActiveCall } from "./marmot-active-call";
import { conversationPhotos, MarmotAttachments } from "./marmot-attachments";
import { useMarmotError } from "./marmot-group";
import { conversationRoute } from "./marmot-inbox";
import { MarmotLocked } from "./marmot-locked";
import { useOpenLater } from "./use-open-later";
import { MarmotLink } from "./marmot-link";
import {
  ConversationSearch,
  ForwardMessage,
  MentionMember,
  MessageEditHistory,
} from "./marmot-message-tools";
import { MarmotPoll, MarmotPollComposer } from "./marmot-poll";
import { useMarmotWindow } from "./marmot-window";
import { OpenLaterSheet } from "./send-options";
import { useMessageTranslations } from "./use-message-translations";
import { useMarmotGroupAvatar } from "./use-marmot-group-avatar";
import { useMentionMembers } from "./use-mention-members";

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
  const { marmotSession, identity, privacy, lock } = useLocal();
  const focused = useIsFocused();
  const foreground = useSyncExternalStore(subscribeForeground, isForeground);
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<{ reason: unknown }>();
  const translateError = useMarmotError();
  const allowed = peer !== identity.publicKey && !privacy.isBlocked(peer);
  useEffect(() => {
    if (!allowed || !focused || !foreground) return;
    let active = true;
    void marmotSession
      .ready()
      .then(() => {
        if (
          !active ||
          !isForeground() ||
          lock.getState().locked ||
          privacy.isBlocked(peer)
        )
          return undefined;
        return marmot.startDirect(peer);
      })
      .then((group) => {
        if (active && group) router.replace(conversationRoute(group));
      })
      .catch((reason) => {
        if (active) setError({ reason });
      });
    return () => {
      active = false;
    };
  }, [allowed, focused, foreground, lock, marmotSession, peer, privacy, retry]);
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
  const {
    identity,
    privacy,
    mediaSdk,
    lock,
    marmotViewport,
    chatPreferences,
    db,
  } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const focused = useIsFocused();
  const foreground = useSyncExternalStore(subscribeForeground, isForeground);
  const open = useCallback(() => marmot.openConversation(id), [id]);
  const { snapshot, window, error, retry } = useMarmotWindow(open);
  const kit = useChatAppearance(true);
  const material = conversationMaterials[kit.colorScheme];
  const translateError = useMarmotError();
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [paging, setPaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const sendingAttachment = useRef<AbortController>(undefined);
  const [upload, setUpload] = useState<
    { kind: "preparing" } | { kind: "uploading"; fraction: number }
  >();
  useEffect(() => {
    if (!focused || !foreground) sendingAttachment.current?.abort();
    const unsubscribe = lock.subscribe(() => {
      if (lock.getState().locked) sendingAttachment.current?.abort();
    });
    return () => {
      unsubscribe();
      sendingAttachment.current?.abort();
    };
  }, [focused, foreground, id, lock]);
  const [composer, setComposer] = useState<string>();
  const [composerFocused, setComposerFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const composerRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [later, setLater] = useState(false);
  const [laterError, setLaterError] = useState<string>();
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [panel, setPanel] = useState<
    "search" | "media" | "edits" | "forward" | "poll" | null
  >(initialPanel ?? null);
  const [searchQuery, setSearchQuery] = useState("");
  const searching = panel === "search" || panel === "media";
  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    setPanel(null);
  }, []);
  useEffect(() => {
    if (!focused || !searching) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => back.remove();
  }, [closeSearch, focused, searching]);
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
  const rows = useMemo(
    () => snapshot && applyAttachmentMetadata(snapshot.messages),
    [snapshot],
  );
  const people = snapshot?.identities;
  const mentionRoster = useMentionMembers(
    id,
    Boolean(snapshot && !snapshot.invited && !peer),
  );
  const mentionNames = useMemo(() => {
    const names = new Map<string, string>(
      people?.map((person) => [toNpub(person.id), person.name]),
    );
    for (const member of mentionRoster.members ?? [])
      names.set(member.npub, member.label);
    return names;
  }, [mentionRoster.members, people]);
  const pins = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.pinned(id),
  );
  const hidden = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.hidden(id),
  );
  const listened = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.listened(id),
  );
  const blockedKeys = privacy.blockedKeys().join(",");
  const snapshotId = id;
  const presentation = useMemo(
    () =>
      createAttachmentPresentation(marmot, ([group, id, source, index]) => {
        const state = window?.getState();
        const app = lock.getState();
        if (
          state?.status !== "ready" ||
          !focused ||
          !foreground ||
          !app.active ||
          app.locked ||
          group !== snapshotId ||
          state.snapshot.invited ||
          !state.snapshot.canSend ||
          (state.snapshot.peer && privacy.isBlocked(state.snapshot.peer)) ||
          chatPreferences.hidden(group).includes(id)
        )
          return false;
        return state.snapshot.messages.some(
          (row) =>
            row.id === id &&
            row.sourceId === source &&
            !row.deleted &&
            !row.invalidated &&
            (row.expiresAt == null || row.expiresAt * 1_000 > Date.now()) &&
            !privacy.isBlocked(row.sender) &&
            row.attachments.some((asset) => asset.index === index),
        );
      }),
    [chatPreferences, focused, foreground, lock, privacy, snapshotId, window],
  );
  useLayoutEffect(() => () => presentation.stop(), [presentation]);
  useLayoutEffect(() => {
    presentation.reconcile();
  }, [blockedKeys, hidden, presentation, snapshot]);
  const openLater = useOpenLater(
    window,
    snapshot,
    Boolean(
      focused &&
      foreground &&
      snapshot?.canSend &&
      !snapshot.invited &&
      !blocked,
    ),
    hidden,
    blockedKeys,
  );
  const messages = useMemo(() => {
    const blocked = new Set(blockedKeys.split(","));
    const omitted = new Set(hidden);
    const played = new Set(listened);
    const names = new Map(people?.map((person) => [person.id, person.name]));
    const user = (key: string) => ({ _id: key, name: names.get(key) });
    return (rows ?? [])
      .filter(
        (row) =>
          row.eventKind !== groupCallKind &&
          !blocked.has(row.sender) &&
          !omitted.has(row.id),
      )
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
        isMediaUnread:
          row.sender !== self &&
          !played.has(row.id) &&
          row.attachments.some(
            (item) =>
              item.type.startsWith("audio/") ||
              item.round ||
              item.name === "video-note.mp4",
          ),
        isPinned: pins.includes(row.id),
        system: Boolean(row.systemType),
        replyMessage:
          row.replyPreview &&
          !blocked.has(row.replyPreview.sender) &&
          !omitted.has(row.replyPreview.id)
            ? {
                _id: row.replyPreview.id,
                text: projectMentions(row.replyPreview.text, mentionNames).text,
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
  }, [
    rows,
    people,
    deleted,
    blockedKeys,
    hidden,
    listened,
    mentionNames,
    pins,
    self,
    t,
  ]);
  const locallyInitiated = Boolean(
    peer &&
    rows?.some(
      (row) =>
        row.token && row.sender === self && row.confirmed && !row.invalidated,
    ),
  );
  const gallery = useMemo(
    () => conversationPhotos(id, messages),
    [id, messages],
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
  const pendingMedia = pendingMediaDraft(snapshot?.draft);
  const canCompose = canSend && !pendingMedia && !upload;
  const canDispatch = () => {
    const state = window?.getState();
    return Boolean(
      state?.status === "ready" &&
      state.snapshot.canSend &&
      !state.snapshot.invited &&
      focused &&
      AppState.currentState === "active" &&
      !lock.getState().locked &&
      !(peer && privacy.isBlocked(peer)),
    );
  };
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

  function submitAttachment(
    request: Pick<
      Parameters<typeof sendMarmotAttachment>[0],
      "caption" | "reply" | "token"
    >,
    source: (
      signal: AbortSignal,
    ) => Promise<Parameters<typeof sendMarmotAttachment>[0]["source"]>,
  ) {
    if (!canDispatch() || sendingAttachment.current) return;
    const controller = new AbortController();
    sendingAttachment.current = controller;
    setUpload({ kind: "preparing" });
    void (async () => {
      await draftWrites.current;
      const prepared = await source(controller.signal);
      if (!canDispatch() || controller.signal.aborted) return;
      await sendMarmotAttachment({
        sdk: mediaSdk,
        group: id,
        ...request,
        source: prepared,
        allowed: canDispatch,
        progress: (fraction) => setUpload({ kind: "uploading", fraction }),
        mirrorFailed: () => Alert.alert(t("messages:mediaMirrorFailed")),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setComposer("");
        setReply(null);
      }
    })()
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) showError(reason);
      })
      .finally(() => {
        if (sendingAttachment.current === controller) {
          sendingAttachment.current = undefined;
          setUpload(undefined);
        }
      });
  }

  function sendMedia(files: MarmotUpload[], caption?: string) {
    if (!canCompose || !files.length) return;
    submitAttachment(
      {
        caption:
          caption?.trim() ||
          (composer ?? snapshot?.draft?.text)?.trim() ||
          null,
        reply: reply?._id ?? snapshot?.draft?.replyTo ?? null,
        token: randomUUID(),
      },
      async (signal) => {
        const prepared = await Promise.all(
          files.map(async (file) => {
            signal.throwIfAborted();
            const video = file.type.startsWith("video/");
            if (file.thumbhash || (!video && !file.type.startsWith("image/")))
              return file;
            let poster: File | undefined;
            try {
              if (video)
                poster = new File(
                  `file://${await marmot.makeVideoPoster(file.path)}`,
                );
              const image = await Image.loadAsync(
                poster?.uri ?? `file://${file.path}`,
                {
                  maxWidth: 96,
                  maxHeight: 96,
                },
              );
              return {
                ...file,
                thumbhash: await Image.generateThumbhashAsync(image),
              };
            } catch {
              return file;
            } finally {
              try {
                poster?.delete();
              } catch {
                /* The OS can reclaim cache files. */
              }
            }
          }),
        );
        return { kind: "files", files: prepared, saveDraft: true };
      },
    );
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

  const menu = [
    { id: "search", title: t("messages:marmot.searchConversation") },
    ...(!peer && snapshot.canSend
      ? [{ id: "call", title: t("calls:startCall") }]
      : []),
    ...(pins.length
      ? [
          {
            id: "pins",
            title: t(
              pins.length === 1
                ? "messages:pinnedMessage"
                : "messages:pinnedMessages",
            ),
          },
        ]
      : []),
    ...(!peer && canSend
      ? [{ id: "poll", title: t("messages:marmot.newPoll") }]
      : []),
    ...(canSend && (composer ?? snapshot.draft?.text)?.trim()
      ? [{ id: "openLater", title: t("messages:openLater") }]
      : []),
  ];

  function selectMenuAction(action: string) {
    switch (action) {
      case "search":
        setSearchQuery("");
        setPanel("search");
        break;
      case "poll":
        if (canDispatch()) setPanel(action);
        break;
      case "call":
        if (!peer && canDispatch()) router.push(conversationRoute(id, "call"));
        break;
      case "pins": {
        if (!pins.length) break;
        const position = pinOffset % pins.length;
        const message = pins[position];
        if (message) moveTo(message);
        setPinOffset(position + 1);
        break;
      }
      case "openLater":
        if (canDispatch()) setLater(true);
        break;
    }
  }

  const draftText = composer ?? snapshot.draft?.text ?? "";
  const draftPresentation = projectMentions(draftText, mentionNames);
  const candidate =
    !peer && canSend && composerFocused && !searching
      ? mentionAt(draftPresentation.text, selection)
      : undefined;
  const mention =
    candidate &&
    !draftPresentation.mentions.some(
      (span) => span.start < candidate.end && candidate.start < span.end,
    )
      ? candidate
      : undefined;

  const searchLabel = t(
    panel === "media"
      ? "messages:marmot.mediaAndFiles"
      : "messages:marmot.searchConversation",
  );

  return (
    <ScreenInsets
      edges={["top", "left", "right"]}
      style={[styles.screen, { backgroundColor: kit.colors.background }]}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient
        pointerEvents="none"
        colors={material.canvas}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {!kit.reducedTransparency && (
        <BackgroundImage
          accessible={false}
          source={require("../../../assets/images/chat-contours.png")}
          resizeMode="cover"
          style={[
            StyleSheet.absoluteFill,
            styles.contours,
            { tintColor: material.contours },
          ]}
        />
      )}
      <GlassSurface
        preset="standard"
        elevation="none"
        tint={material.panel}
        style={styles.header}
      >
        {searching ? (
          <View
            style={[
              styles.searchHeader,
              { direction: kit.rtl ? "rtl" : "ltr" },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common:close")}
              onPress={closeSearch}
              style={styles.menuButton}
            >
              <Icon name="back" color={kit.colors.text} />
            </Pressable>
            <View style={styles.searchField}>
              <Search
                accessibilityLabel={searchLabel}
                placeholder={searchLabel}
                value={searchQuery}
                onChangeText={setSearchQuery}
                maxLength={128}
                autoFocus={panel === "search"}
              />
            </View>
          </View>
        ) : (
          <ChatHeader
            {...kit}
            title={title}
            avatar={
              snapshot.invited
                ? undefined
                : { id: peer ?? id, uri: peer ? avatar : groupAvatar }
            }
            onBack={() =>
              router.canGoBack() ? router.back() : router.replace("/messages")
            }
            onPressTitle={
              snapshot.invited
                ? undefined
                : () => router.push(conversationRoute(id, "details"))
            }
            renderRight={
              snapshot.invited
                ? undefined
                : () => (
                    <View style={styles.headerActions}>
                      {peer && !blocked && (
                        <IconButton
                          icon="phone"
                          label={t("messages:call")}
                          onPress={() => {
                            if (!privacy.isBlocked(peer))
                              router.push({
                                pathname: "/call/[key]",
                                params: { key: peer },
                              });
                          }}
                        />
                      )}
                      <ActionMenu
                        label={t("messages:marmot.chatOptions")}
                        actions={menu}
                        onSelect={selectMenuAction}
                      >
                        <View
                          style={[
                            styles.menuButton,
                            { backgroundColor: kit.colors.accentSoft },
                          ]}
                        >
                          <Icon name="more" color={kit.colors.accent} />
                        </View>
                      </ActionMenu>
                    </View>
                  )
            }
            isTopInsetApplied={false}
            style={styles.headerContent}
          />
        )}
      </GlassSurface>
      {snapshot.invited ? (
        <MarmotInvitation
          id={id}
          direct={Boolean(peer)}
          busy={busy}
          setBusy={setBusy}
        />
      ) : (
        <>
          {!peer && !searching && snapshot.canSend && (
            <MarmotActiveCall
              group={id}
              messages={rows}
              members={mentionRoster.members}
            />
          )}
          {upload && (
            <View style={styles.uploadStatus}>
              <Ink kind="caption">
                {upload.kind === "preparing"
                  ? t("messages:voiceUpload_checking")
                  : t("messages:voiceUploadProgress", {
                      percent: Math.floor(upload.fraction * 100),
                    })}
              </Ink>
              <Action
                size="sm"
                onPress={() => sendingAttachment.current?.abort()}
              >
                {t("common:cancel")}
              </Action>
            </View>
          )}
          {!upload && pendingMedia && canSend && (
            <View style={styles.uploadStatus}>
              <Ink kind="caption">
                {t(
                  pendingMedia.kind === "ready"
                    ? "messages:mediaReadyToResume"
                    : "messages:mediaDraftIncomplete",
                )}
              </Ink>
              {pendingMedia.kind === "ready" && (
                <Action
                  size="sm"
                  disabled={busy}
                  onPress={() =>
                    submitAttachment(
                      {
                        caption: snapshot.draft?.text ?? null,
                        reply: snapshot.draft?.replyTo ?? null,
                        token: pendingMedia.token,
                      },
                      async () => ({
                        kind: "draft",
                        attachments: pendingMedia.attachments,
                      }),
                    )
                  }
                >
                  {t("common:retry")}
                </Action>
              )}
              <Action
                size="sm"
                disabled={busy}
                onPress={() => {
                  if (!canDispatch() || sendingAttachment.current) return;
                  setBusy(true);
                  void marmot
                    .discardMediaDraft(id)
                    .catch(showError)
                    .finally(() => setBusy(false));
                }}
              >
                {t("messages:mediaDiscardDraft")}
              </Action>
            </View>
          )}
          {searching && (
            <ConversationSearch
              group={id}
              media={panel === "media"}
              query={searchQuery}
              onSelect={(message, term) => {
                Keyboard.dismiss();
                moveTo(message, term);
              }}
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
              labels={
                peer
                  ? kit.labels
                  : {
                      ...kit.labels,
                      emptyChatText: t("messages:marmot.emptyGroup"),
                    }
              }
              messages={translated.displayed}
              chatRef={chatRef}
              highlightText={highlight}
              user={{ _id: self }}
              mediaPlayback={{
                isAutoPlayNextEnabled: false,
                isRoundVideoAutoplayEnabled: false,
                isFloatingRoundNoteEnabled: false,
                isNowPlayingBarEnabled: true,
                onMediaRead: (message) =>
                  chatPreferences.markListened(id, String(message._id)),
              }}
              mediaTransfer={{
                onDownload: (message) =>
                  presentation.download(String(message._id)),
                onCancel: (message) => presentation.cancel(String(message._id)),
              }}
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
              textInputRef={composerRef}
              textInputProps={{
                onFocus: () => setComposerFocused(true),
                onBlur: () => setComposerFocused(false),
                onSelectionChange: ({ nativeEvent }) =>
                  setSelection(nativeEvent.selection),
              }}
              renderComposer={(props) => {
                const presentation = projectMentions(
                  props.text ?? "",
                  mentionNames,
                );
                return (
                  <Composer
                    {...props}
                    text={presentation.text}
                    textInputProps={{
                      ...props.textInputProps,
                      onChangeText: (next) =>
                        props.textInputProps?.onChangeText?.(
                          editMentionText(presentation, next),
                        ),
                    }}
                  />
                );
              }}
              renderMessageText={(props) => (
                <MessageText
                  {...props}
                  currentMessage={{
                    ...props.currentMessage,
                    text: projectMentions(
                      props.currentMessage.text,
                      mentionNames,
                    ).text,
                  }}
                />
              )}
              renderInputToolbar={(props) =>
                canCompose ? (
                  <>
                    {mention && !props.editMessage && (
                      <MentionMember
                        roster={mentionRoster}
                        query={mention.query}
                        onSelect={(npub) => {
                          if (!canDispatch()) return;
                          const inserted = insertMention(
                            draftText,
                            {
                              start: mentionWireOffset(
                                draftPresentation,
                                mention.start,
                              ),
                              end: mentionWireOffset(
                                draftPresentation,
                                mention.end,
                              ),
                            },
                            npub,
                          );
                          const caret = projectMentions(
                            inserted.text.slice(0, inserted.caret),
                            mentionNames,
                          ).text.length;
                          setSelection({
                            start: caret,
                            end: caret,
                          });
                          saveDraft(inserted.text, reply?._id ?? null);
                          requestAnimationFrame(() =>
                            composerRef.current?.setSelection(caret, caret),
                          );
                        }}
                      />
                    )}
                    <InputToolbar {...props} />
                  </>
                ) : blocked ? (
                  <Ink>{t("messages:marmot.blocked")}</Ink>
                ) : null
              }
              onDraftChange={(text) => {
                if (!sendingAttachment.current && !pendingMedia)
                  saveDraft(text, reply?._id ?? null);
              }}
              listProps={{ onViewableItemsChanged: onVisible }}
              attachments={{
                isEnabled: canCompose,
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
              onSend={
                canCompose
                  ? (batch) => {
                      for (const item of batch) {
                        if (item.audio || item.video) {
                          try {
                            const file = item.audio
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
                                );
                            file.presentation = item.audio
                              ? "voice"
                              : item.videoNote
                                ? "round"
                                : undefined;
                            if (item.duration && Number.isFinite(item.duration))
                              file.duration = String(
                                Math.max(1, Math.round(item.duration)),
                              );
                            if (item.waveform?.length) {
                              const waveform = item.waveform;
                              const count = Math.min(waveform.length, 48);
                              file.waveform = Array.from(
                                { length: count },
                                (_, index) => {
                                  const level =
                                    waveform[
                                      Math.floor(
                                        (index * waveform.length) / count,
                                      )
                                    ] ?? 0;
                                  return Math.round(
                                    Math.max(0, Math.min(1, level)) * 31,
                                  );
                                },
                              ).join(",");
                            }
                            sendMedia([file], item.text);
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
                if (canSend && !peer && row.sender !== self)
                  actions.push({
                    key: "report",
                    label: t("messages:marmot.reportMessage"),
                    onPress: () =>
                      Alert.alert(
                        t("messages:marmot.reportMessage"),
                        t("messages:marmot.reportVisibility"),
                        [
                          { text: t("common:cancel"), style: "cancel" },
                          {
                            text: t("messages:marmot.reportSpam"),
                            onPress: () =>
                              run(() =>
                                marmot.reportMessage(id, row.id, "spam"),
                              ),
                          },
                          {
                            text: t("messages:marmot.reportOther"),
                            onPress: () =>
                              run(() =>
                                marmot.reportMessage(id, row.id, "other"),
                              ),
                          },
                        ],
                      ),
                  });
                actions.push({
                  key: "deleteLocal",
                  label: t("messages:marmot.removeForMe"),
                  destructive: true,
                  onPress: () => {
                    chatPreferences.hide(id, row.id);
                    if (row.eventKind === timeLockKind)
                      removeOpenedMessage(db, row.id);
                  },
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
                      state={openLater.states?.get(row.id)}
                      retry={() => openLater.retry(row.id)}
                      rtl={kit.rtl}
                    />
                  );
                return row.attachments.length ? (
                  focused && foreground && !blocked ? (
                    <MarmotAttachments
                      group={id}
                      row={row}
                      message={currentMessage}
                      presentation={presentation}
                      gallery={gallery}
                    />
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
              audioRecording={canCompose}
              videoRecording={canCompose}
            />
          </View>
          {panel === "poll" && canSend && (
            <MarmotPollComposer
              group={id}
              cancel={() => setPanel(null)}
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
    </ScreenInsets>
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
  const [invitation, setInvitation] =
    useState<Pick<MarmotGroupDetails, "inviter" | "name" | "members">>();
  useEffect(() => {
    let active = true;
    void marmot
      .groupDetails(id)
      .then((group) => {
        if (active) setInvitation(group);
      })
      .catch(() => {
        if (active) setInvitation({ name: "", members: [] });
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
  const participantNames = invitation?.members
    .filter((member) => !member.self && !privacy.isBlocked(member.id))
    .slice(0, 4)
    .map((member) => member.name || member.npub.slice(0, 15) + "…")
    .join(", ");
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
      {allowed && !direct && invitation && invitation.members.length > 0 && (
        <Ink kind="caption">
          {t("messages:marmot.members")} ({invitation.members.length})
          {participantNames ? "\n" + participantNames : ""}
        </Ink>
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
  uploadStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
  },
  screen: { flex: 1 },
  contours: { width: "100%", height: "100%", opacity: 0.25 },
  header: {
    borderRadius: radius.card,
    zIndex: 1,
    marginHorizontal: space.sm,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  headerContent: {
    backgroundColor: "transparent",
    boxShadow: "none",
    paddingEnd: space.xs,
    borderRadius: radius.card,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  searchHeader: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 56,
    paddingEnd: space.sm,
  },
  searchField: { flex: 1 },
  menuButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  chat: { flex: 1 },
  invitation: { padding: space.md, gap: space.sm },
});
