import {
  acceptedAttachments,
  delivery,
} from "@/core/marmot/message-projection";
import { quoteText } from "@/core/marmot/message-content";
import { PreparedMessageText } from "./prepared-message-text";
import { useContacts } from "@/db/contacts";
import { useAudioActions } from "@/components/audio/actions";
import { VoiceUploadAttachment } from "@/components/audio/attachment";
import { usePlayerPresentation } from "@/components/audio/presentation";
import { conversationWindowActive } from "@/core/marmot/conversation-route";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { audioFile, showMiniPlayer } from "@/core/audio/types";
import { playerPlayback } from "@/core/audio/controller";
import { ScreenHeader } from "@/components/navigation/screen-header";
import Transition from "react-native-screen-transitions";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import {
  Bubble,
  Chat,
  type ChatHandle,
  Composer,
  type IMessage,
  InputToolbar,
} from "@kesha-antonov/react-native-chat";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router, useIsFocused, useNavigation, useRoute } from "expo-router";
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
  type AlertButton,
  AppState,
  BackHandler,
  Image as BackgroundImage,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  type TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { ActionMenu } from "@/components/ui/action-menu";
import { GlassBackButton } from "@/components/ui/back-button";
import { LoadingStatus } from "@/components/ui/loading-status";
import {
  Action,
  Avatar,
  Empty,
  Icon,
  IconButton,
  Ink,
  Screen,
  Search,
  tapFeedback,
} from "@/components/ui/kit";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { usePresentedPerson } from "@/components/people/use-person";
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
import { speechSource } from "@/core/speech/service";
import {
  marmot,
  type MarmotGroupInvitation,
  type MarmotMessage,
  type MarmotUpload,
} from "@/core/marmot/native";
import {
  pendingMediaDraft,
  waitForAttachmentForeground,
} from "@/core/marmot/media-send";
import { sendMarmotAttachment } from "@/core/marmot/send-attachment";
import { localMediaUri } from "@/core/media/open-local-attachment";
import { contactByKey } from "@/db/queries";
import { removeOpenedMessage } from "@/db/open-later";
import { namespaces } from "@/i18n";
import { useChatPresentation, useLocal } from "@/services/local-context";
import { radius, space } from "@/theme";
import { conversationMaterials, useChatAppearance } from "./appearance";
import { GroupCallHeaderButton, MarmotActiveCall } from "./marmot-active-call";
import {
  audioTrackForMessage,
  conversationPhotos,
  MarmotAttachments,
  exportMarmotAttachment,
} from "./marmot-attachments";
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
import { useConversationWindow } from "./marmot-window";
import { OpenLaterSheet } from "./send-options";
import { useMessageTranslations } from "./use-message-translations";
import { usePreparedGroupAvatar } from "./use-prepared-group-avatar";
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
const noVisibleMessages: ReadonlySet<string> = new Set();

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
    <Screen navigationHeader={<ScreenHeader title={title} />}>
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

type PreparedMessageEntry = {
  context: readonly unknown[];
  message: ChatMessage;
};
// Native deltas keep unchanged rows by reference. Weak keys tie prepared
// rows to the lifetime of that projection, including across React mounts.
const preparedMessages = new WeakMap<MarmotMessage, PreparedMessageEntry>();

const locationsByMessage = new WeakMap<
  MarmotMessage,
  { text: string; location: ReturnType<typeof locationFromText> }
>();

function messageLocation(row: MarmotMessage) {
  const cached = locationsByMessage.get(row);
  if (cached?.text === row.text) return cached.location;
  const location = locationFromText(row.text);
  locationsByMessage.set(row, { text: row.text, location });
  return location;
}

type AttachmentRequest = Pick<
  Parameters<typeof sendMarmotAttachment>[0],
  "caption" | "reply" | "token"
>;

type VoiceSend = AttachmentRequest & {
  createdAt: number;
  duration?: number;
  waveform?: number[];
  file?: MarmotUpload;
  sizes?: readonly number[];
  messageId?: string;
  phase: "uploading" | "accepted" | "failed";
};

function localUpload(uri: string, name: string, type: string): MarmotUpload {
  if (uri.startsWith("/")) return { path: uri, name, type };
  if (!uri.startsWith("file:///")) throw new Error("InvalidMediaPath");
  return { path: decodeURIComponent(uri.slice(7)), name, type };
}

export function MarmotConversationScreen({
  id,
  initialPanel,
  audioMessage,
}: {
  id: string;
  audioMessage?: string;
  initialPanel?: "search" | "media";
}) {
  const { t } = useTranslation(namespaces);
  const navigation = useNavigation();
  const {
    identity,
    privacy,
    mediaSdk,
    lock,
    marmotViewport,
    chatPreferences,
    db,
    marmotSession,
    conversations,
    speech,
    audio,
    calling,
    downloads,
  } = useLocal();
  const { open: openAudio, queue: queueAudio } = useAudioActions();
  const recordingOwner = useRef(Symbol("chat recording")).current;
  const audioSessionOwner = useRef(Symbol("recorder audio session")).current;
  const recordingChanged = useCallback(
    (active: boolean) => {
      audio.recording(active, recordingOwner);
      speech.setRecording(active);
    },
    [audio, recordingOwner, speech],
  );
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const focused = useIsFocused();
  const route = useRoute();
  const subscribeNavigation = useCallback(
    (notify: () => void) => navigation.addListener("state", notify),
    [navigation],
  );
  const keepChatWindow = useSyncExternalStore(subscribeNavigation, () => {
    const state = navigation.getState();
    return state ? conversationWindowActive(state, route.key, id) : focused;
  });
  const { miniHeight } = usePlayerPresentation();
  const { top: safeTop } = useSafeAreaInsets();
  const playerClearance = miniHeight - safeTop + space.sm;
  const playerVisible = useStore(
    audio.store,
    (state) =>
      !state.blocked && showMiniPlayer(playerPlayback(state)?.track, id),
  );
  const chromeOffset = playerVisible ? playerClearance : 0;
  const foreground = useSyncExternalStore(subscribeForeground, isForeground);
  const locked = useSyncExternalStore(lock.subscribe, lock.getState).locked;
  const accountRevision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const target =
    audioMessage && !chatPreferences.hidden(id).includes(audioMessage)
      ? audioMessage
      : undefined;
  const { snapshot, window, error, retry } = useConversationWindow(
    id,
    target,
    keepChatWindow,
  );
  const [opening] = useState(() => ({
    at: conversations.navigationStarted(id),
    cached: Boolean(snapshot),
    position: conversations.position(id, target),
  }));
  const presentedGeneration = useRef<string>(undefined);
  const readyGeneration = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!snapshot || presentedGeneration.current === snapshot.generation)
      return;
    presentedGeneration.current = snapshot.generation;
    messagingMetric("conversation snapshot committed", {
      cached: opening.cached,
      ms: performance.now() - opening.at,
      rows: snapshot.messages.length,
    });
  }, [opening, snapshot]);
  const messageStyle = useChatPresentation();
  const kit = useChatAppearance(messageStyle);
  const material = conversationMaterials[kit.colorScheme];
  const translateError = useMarmotError();
  const [reply, setReply] = useState<ChatMessage | null>(null);
  const [paging, setPaging] = useState(false);
  const pagingWindow = useRef<typeof window>(undefined);
  const [busy, setBusy] = useState(false);
  const sendingAttachment = useRef<AbortController>(undefined);
  const [upload, setUpload] = useState<
    { kind: "preparing" } | { kind: "uploading"; fraction: number }
  >();
  const [voiceSend, setVoiceSend] = useState<VoiceSend>();
  const [openedAt] = useState(Date.now);
  useEffect(() => {
    const cancel = () => sendingAttachment.current?.abort();
    const unsubscribeBlur = navigation.addListener("blur", cancel);
    const unsubscribe = lock.subscribe(() => {
      if (lock.getState().locked) cancel();
    });
    return () => {
      unsubscribe();
      unsubscribeBlur();
      cancel();
    };
  }, [id, lock, navigation]);
  const [composer, setComposer] = useState<string>();
  const [composerFocused, setComposerFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const composerRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [later, setLater] = useState(false);
  const [laterError, setLaterError] = useState<string>();
  const [visibility, setVisibility] = useState<{
    generation: string;
    ids: ReadonlySet<string>;
  }>();
  const visibleGeneration = snapshot?.generation;
  const visible =
    visibility && visibility.generation === visibleGeneration
      ? visibility.ids
      : noVisibleMessages;
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
  const [jump, setJump] = useState<{ message: string } | { latest: true }>();
  const [highlight, setHighlight] = useState("");
  const [pinOffset, setPinOffset] = useState(0);
  const chatRef = useRef<ChatHandle | null>(null);
  const lastRead = useRef<string | undefined>(undefined);
  const draftWrites = useRef(Promise.resolve());
  const deferredDraft = useRef<{ text: string; target: string | null }>(
    undefined,
  );
  const peer = snapshot?.peer;
  const { name: peerName, photo: avatar } = usePresentedPerson(
    snapshot?.invited ? "" : (peer ?? ""),
    snapshot?.title,
  );
  const groupAvatar = usePreparedGroupAvatar(
    !peer && !snapshot?.invited && snapshot?.image
      ? snapshot.avatarAsset
      : undefined,
  );
  const self = identity.publicKey;
  const blocked = Boolean(peer && privacy.isBlocked(peer));
  const title = snapshot?.invited
    ? t("messages:marmot.invitations")
    : peer
      ? peerName
      : snapshot?.title || t("messages:marmot.group");
  const rows = snapshot?.messages;
  const people = snapshot?.identities;
  const contacts = useContacts();
  const mentionRoster = useMentionMembers(
    id,
    Boolean(snapshot && !snapshot.invited && !peer && composerFocused),
  );
  const mentionNames = useMemo(() => {
    const names = new Map<string, string>(
      people?.map((person) => [toNpub(person.id), person.name]),
    );
    for (const member of mentionRoster.members ?? [])
      names.set(member.npub, member.label);
    for (const contact of contacts)
      if (contact.name && names.has(toNpub(contact.publicKey)))
        names.set(toNpub(contact.publicKey), contact.name);
    return names;
  }, [contacts, mentionRoster.members, people]);
  const pins = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.pinned(id),
  );
  const hidden = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.hidden(id),
  );
  const listened = useSyncExternalStore(chatPreferences.subscribe, () =>
    chatPreferences.listened(id),
  );
  const blockState = privacy.blocks.snapshot();
  const presentation = useMemo(
    () =>
      createAttachmentPresentation(
        marmot,
        downloads,
        (target) => {
          const [group, message, source, index] = target;
          const state = window?.getState();
          if (
            state?.status !== "ready" ||
            lock.getState().locked ||
            group !== id ||
            state.snapshot.invited ||
            !state.snapshot.canSend ||
            (state.snapshot.peer && privacy.isBlocked(state.snapshot.peer)) ||
            chatPreferences.hidden(group).includes(message)
          )
            return;
          const row = state.snapshot.messages.find(
            (row) =>
              row.id === message &&
              row.sourceId === source &&
              !row.deleted &&
              !row.invalidationStatus &&
              (row.expiresAt == null || row.expiresAt * 1_000 > Date.now()) &&
              !privacy.isBlocked(row.sender),
          );
          const asset =
            row &&
            acceptedAttachments(row).find((asset) => asset.index === index);
          if (!row || !asset) return;
          return {
            kind: "marmot",
            target,
            sender: row.sender,
            expiresAt: row.expiresAt == null ? null : row.expiresAt * 1000,
            name: asset.name,
            hash: asset.plaintextHash,
            type: asset.type,
            total: asset.size ?? null,
            voice: speechSource(group, row, asset, identity.publicKey),
          };
        },
        () => navigation.isFocused() && isForeground(),
      ),
    [
      chatPreferences,
      downloads,
      id,
      identity.publicKey,
      lock,
      navigation,
      privacy,
      window,
    ],
  );
  useSyncExternalStore(
    presentation.subscribeAvailability,
    presentation.availabilityRevision,
  );
  useLayoutEffect(() => () => presentation.stop(), [presentation]);
  useLayoutEffect(() => {
    presentation.reconcile();
    for (const row of snapshot?.messages ?? [])
      if (row.deleted || row.invalidationStatus)
        downloads.invalidate(id, row.id);
  }, [blockState, downloads, hidden, id, locked, presentation, snapshot]);
  useEffect(() => {
    if (
      !focused ||
      !foreground ||
      locked ||
      blocked ||
      snapshot?.invited ||
      !snapshot?.canSend
    )
      return;
    void speech.reconcile();
    const recent = [...snapshot.messages]
      .sort((left, right) => right.sentAt - left.sentAt)
      .slice(0, 16);
    for (const row of recent) {
      if (row.sender !== self || hidden.includes(row.id)) continue;
      for (const item of acceptedAttachments(row)) {
        const source = speechSource(id, row, item, self);
        if (source) speech.outgoing(source, row.sentAt);
      }
    }
  }, [
    blocked,
    focused,
    foreground,
    hidden,
    id,
    locked,
    self,
    snapshot,
    speech,
  ]);
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
    blockState,
  );
  const messages = useMemo(() => {
    const blocked = (key: string) =>
      key !== self &&
      (blockState.status !== "ready" || blockState.keys.has(key));
    const omitted = new Set(hidden);
    const played = new Set(listened);
    const names = new Map(people?.map((person) => [person.id, person.name]));
    for (const contact of contacts)
      if (contact.name) names.set(contact.publicKey, contact.name);
    const user = (key: string) => ({ _id: key, name: names.get(key) });
    const deletionLabel = (source: MarmotMessage["deletionSource"]) =>
      t(
        source === "admin"
          ? "messages:marmot.removedByAdmin"
          : "messages:marmot.removedMessage",
      );
    const prepared = (rows ?? [])
      .filter((row) => {
        if ((row.system || !blocked(row.sender)) && !omitted.has(row.id))
          return true;
        preparedMessages.delete(row);
        return false;
      })
      .map((row): ChatMessage => {
        const sender = names.get(row.sender);
        const pinned = pins.includes(row.id);
        const unheard = !played.has(row.id);
        const subject = row.system?.subject ?? row.system?.actor;
        const eventName =
          row.system?.name ||
          (subject && !blocked(subject) && names.get(subject));
        const quote = row.replyPreview;
        const visibleQuote =
          quote && !blocked(quote.sender) && !omitted.has(quote.id)
            ? quote
            : undefined;
        const missingQuote =
          !quote && row.replyTo && !omitted.has(row.replyTo)
            ? row.replyTo
            : undefined;
        const context = [
          self,
          sender,
          pinned,
          unheard,
          eventName,
          missingQuote,
          (row.system || row.deleted || missingQuote) && t,
        ];
        // Quote plans are cached separately. Their labels and relative
        // timestamps are formatted against the current presentation.
        const prior = visibleQuote ? undefined : preparedMessages.get(row);
        if (prior?.context.every((value, index) => value === context[index]))
          return prior.message;
        const status = row.sender === self ? delivery(row) : undefined;
        const message: ChatMessage = {
          _id: row.id,
          direction: row.sender === self ? "outgoing" : "incoming",
          createdAt: row.sentAt * 1_000,
          user: { _id: row.sender, name: sender },
          text: row.system
            ? [t(systemLabel(row.system.type)), eventName]
                .filter(Boolean)
                .join(" · ")
            : row.deleted
              ? deletionLabel(row.deletionSource)
              : row.eventKind === timeLockKind ||
                  row.eventKind === locationKind ||
                  row.poll
                ? ""
                : row.text,
          location:
            row.eventKind === locationKind && !row.deleted
              ? messageLocation(row)
              : undefined,
          pending: status === "pending",
          sent: status === "published" || status === "received",
          isFailed: status === "failed",
          isEdited: row.edited,
          isMediaUnread:
            row.sender !== self &&
            unheard &&
            acceptedAttachments(row).some(
              (item) =>
                item.type.startsWith("audio/") ||
                item.round ||
                item.name === "video-note.mp4",
            ),
          isPinned: pinned,
          system: Boolean(row.system),
          replyMessage: visibleQuote
            ? {
                _id: visibleQuote.id,
                text: visibleQuote.deleted
                  ? deletionLabel(visibleQuote.deletionSource)
                  : visibleQuote.invalidationStatus
                    ? t("messages:unavailableQuote")
                    : quoteText(
                        visibleQuote.content,
                        visibleQuote.text,
                        mentionNames,
                      ),
                user: user(visibleQuote.sender),
              }
            : missingQuote
              ? {
                  _id: missingQuote,
                  text: t("messages:unavailableQuote"),
                  user: { _id: "" },
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
        };
        if (!visibleQuote) preparedMessages.set(row, { context, message });
        return message;
      });
    const alreadyNewestFirst = prepared.every(
      (message, index) =>
        index === 0 ||
        Number(prepared[index - 1].createdAt) >= Number(message.createdAt),
    );
    const ordered = alreadyNewestFirst
      ? prepared
      : prepared.sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
    return ordered;
  }, [
    rows,
    contacts,
    people,
    blockState,
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
        row.token &&
        row.sender === self &&
        (delivery(row) === "published" || delivery(row) === "received"),
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
    setJump({ message });
    if (!messages.some((row) => row._id === message)) {
      void window?.jump(message).catch((reason) => {
        setJump(undefined);
        showError(reason);
      });
    }
  }
  useEffect(() => {
    if (!jump || !focused || !foreground || locked) return;
    const latest = "latest" in jump;
    const target = latest ? messages[0]?._id : jump.message;
    if (!target || (!latest && !messages.some((row) => row._id === target)))
      return;
    const task = requestAnimationFrame(() => {
      if (!navigation.isFocused() || lock.getState().locked) return;
      chatRef.current?.scrollToMessage(
        target,
        latest ? { viewPosition: 1, animated: false } : { isHighlighted: true },
      );
      setJump(undefined);
    });
    return () => cancelAnimationFrame(task);
  }, [focused, foreground, jump, lock, locked, messages, navigation]);
  const canSend = Boolean(snapshot?.canSend && !blocked && !snapshot.invited);
  const pendingMedia = pendingMediaDraft(snapshot?.draft);
  const canCompose = canSend && !pendingMedia && !upload;
  const recoveredVoice: VoiceSend | undefined =
    pendingMedia?.kind === "ready" && pendingMedia.voice
      ? {
          token: pendingMedia.token,
          createdAt: openedAt,
          caption: snapshot?.draft?.text ?? null,
          reply: snapshot?.draft?.replyTo ?? null,
          duration: pendingMedia.voice.duration ?? undefined,
          waveform: pendingMedia.voice.waveform,
          sizes: pendingMedia.sizes,
          phase: "failed",
        }
      : undefined;
  const voice = voiceSend ?? recoveredVoice;
  const showVoice =
    voice &&
    !rows?.some(
      (row) =>
        row.id === voice.messageId ||
        (row.sender === self && row.token === voice.token),
    );
  if (voiceSend && voiceSend.phase !== "uploading" && !showVoice)
    setVoiceSend(undefined);
  const groupCreatedAt = useMemo(
    () => chatPreferences.groupCreatedAt(id),
    [chatPreferences, id],
  );
  const showGroupCreation = Boolean(
    snapshot &&
    !snapshot.invited &&
    !peer &&
    !snapshot.hasMoreBefore &&
    groupCreatedAt,
  );
  const timeline = useMemo<ChatMessage[]>(() => {
    if (!showGroupCreation || !groupCreatedAt) return translated.displayed;
    return [
      ...translated.displayed,
      {
        _id: `group-created:${id}`,
        direction: "incoming",
        createdAt: groupCreatedAt * 1000,
        user: { _id: self },
        text: t("messages:marmot.eventGroupCreated"),
        system: true,
      },
    ];
  }, [groupCreatedAt, id, self, showGroupCreation, t, translated.displayed]);
  const displayed: ChatMessage[] =
    showVoice && voice
      ? [
          {
            _id: `voice-upload:${voice.token}`,
            user: { _id: self },
            text: voice.caption ?? "",
            createdAt: voice.createdAt,
            direction: "outgoing",
            pending: voice.phase !== "failed",
            isFailed: voice.phase === "failed",
          },
          ...timeline,
        ]
      : timeline;
  const initialMessage =
    target ?? (snapshot?.firstUnread ? undefined : opening.position?.id);
  const initialMessageIndex = initialMessage
    ? displayed.findIndex((row) => row._id === initialMessage)
    : -1;
  const rememberedScroll = opening.position?.scroll;
  const initialScrollOffset =
    !target &&
    initialMessageIndex >= 0 &&
    rememberedScroll &&
    rememberedScroll.generation === snapshot?.generation &&
    rememberedScroll.sequence === snapshot?.sequence
      ? rememberedScroll.y
      : undefined;
  const rememberScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (navigation.isFocused() && isForeground() && !lock.getState().locked)
        conversations.rememberOffset(
          id,
          target,
          event.nativeEvent.contentOffset.y,
        );
    },
    [conversations, id, lock, navigation, target],
  );
  const canSendFromWindow = () => {
    const state = window?.getState();
    return Boolean(
      state?.status === "ready" &&
      state.snapshot.canSend &&
      !state.snapshot.invited &&
      navigation.isFocused() &&
      !lock.getState().locked &&
      !(state.snapshot.peer && privacy.isBlocked(state.snapshot.peer)),
    );
  };
  const canDispatch = () => isForeground() && canSendFromWindow();
  const run = (fn: () => Promise<unknown>) => {
    if (canDispatch()) void fn().catch(showError);
  };

  function deletionTargets(ids: ReadonlySet<string>) {
    const state = window?.getState();
    if (
      !ids.size ||
      state?.status !== "ready" ||
      state.snapshot.invited ||
      !navigation.isFocused() ||
      !isForeground() ||
      lock.getState().locked
    )
      return;
    const hidden = chatPreferences.hidden(id);
    const targets = state.snapshot.messages.filter(
      (row) =>
        ids.has(row.id) &&
        !row.deleted &&
        !row.system &&
        !hidden.includes(row.id) &&
        (row.expiresAt == null || row.expiresAt * 1000 > Date.now()),
    );
    if (targets.length === ids.size) return targets;
  }

  function canDeleteForEveryone(row: MarmotMessage) {
    return (
      row.sender === self &&
      (delivery(row) === "published" || delivery(row) === "received")
    );
  }

  function requestDeletion(messageIds: readonly string[]) {
    const ids = new Set(messageIds);
    const targets = deletionTargets(ids);
    if (!targets) return;
    const buttons: AlertButton[] = [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("messages:marmot.deleteForMe"),
        onPress: () => {
          void (async () => {
            if (!deletionTargets(ids)) return;
            for (const messageId of ids) {
              if (marmotSession.revision() !== accountRevision) return;
              const row = deletionTargets(new Set([messageId]))?.[0];
              if (!row) continue;
              if (
                row.sender === self &&
                row.invalidationStatus === "local_publish_failed"
              ) {
                const outcome = await marmot.discardFailedSend(id, row.id);
                if (marmotSession.revision() !== accountRevision) return;
                if (outcome !== "discarded") continue;
              } else chatPreferences.hide(id, row.id);
              speech.invalidateMessage(id, row.id);
              downloads.invalidate(id, row.id);
              if (row.eventKind === timeLockKind)
                removeOpenedMessage(db, row.id);
            }
          })().catch(showError);
        },
      },
    ];
    if (canDispatch() && targets.every(canDeleteForEveryone))
      buttons.push({
        text: t("messages:marmot.deleteForEveryone"),
        style: "destructive",
        onPress: () =>
          run(async () => {
            const selected = deletionTargets(ids);
            if (!selected?.every(canDeleteForEveryone)) return;
            for (const row of selected) {
              if (!canDispatch()) return;
              const current = deletionTargets(new Set([row.id]))?.[0];
              if (!current || !canDeleteForEveryone(current)) continue;
              await marmot.deleteMessage(id, row.id);
              speech.invalidateMessage(id, row.id);
              downloads.invalidate(id, row.id);
            }
          }),
      });
    Alert.alert(t("chatKit:labels.actionDelete"), undefined, buttons);
  }

  const writeDraft = useCallback(
    (text: string, target: string | null) => {
      draftWrites.current = draftWrites.current
        .then(() => marmot.saveDraft(id, text, target))
        .catch(() => undefined);
    },
    [id],
  );
  function saveDraft(text: string, target: string | null) {
    setComposer(text);
    if (!canDispatch()) return;
    if (sendingAttachment.current || pendingMedia) {
      deferredDraft.current = { text, target };
      return;
    }
    deferredDraft.current = undefined;
    writeDraft(text, target);
  }
  useEffect(() => {
    if (
      !canCompose ||
      !focused ||
      !foreground ||
      locked ||
      sendingAttachment.current
    )
      return;
    const deferred = deferredDraft.current;
    if (!deferred) return;
    deferredDraft.current = undefined;
    writeDraft(deferred.text, deferred.target);
  }, [canCompose, focused, foreground, locked, writeDraft]);
  const onVisible = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: { item: ChatMessage; isViewable: boolean }[];
    }) => {
      if (
        !visibleGeneration ||
        !navigation.isFocused() ||
        !isForeground() ||
        lock.getState().locked
      )
        return;
      const next = new Set(
        viewableItems
          .filter(({ isViewable }) => isViewable)
          .map(({ item }) => item._id),
      );
      setVisibility((previous) =>
        previous?.generation === visibleGeneration &&
        next.size === previous.ids.size &&
        [...next].every((key) => previous.ids.has(key))
          ? previous
          : { generation: visibleGeneration, ids: next },
      );
    },
    [lock, navigation, visibleGeneration],
  );
  useEffect(() => {
    if (
      !focused ||
      !foreground ||
      locked ||
      snapshot?.invited ||
      blocked ||
      !navigation.isFocused() ||
      lock.getState().locked
    )
      return;
    const latest = messages.reduce<ChatMessage | undefined>(
      (selected, item) =>
        item.row &&
        visible.has(item._id) &&
        (!selected || Number(item.createdAt) > Number(selected.createdAt))
          ? item
          : selected,
      undefined,
    );
    if (!latest?.row) return;
    conversations.remember(
      id,
      target,
      latest === messages[0] && !snapshot?.hasMoreAfter
        ? undefined
        : latest._id,
    );
    if (latest._id === lastRead.current) return;
    lastRead.current = latest._id;
    void marmot.markRead(id, latest._id).catch(() => {
      if (lastRead.current === latest._id) lastRead.current = undefined;
    });
  }, [
    blocked,
    conversations,
    focused,
    foreground,
    id,
    lock,
    locked,
    messages,
    navigation,
    snapshot?.hasMoreAfter,
    snapshot?.invited,
    target,
    visible,
  ]);
  async function page(direction: "older" | "latest") {
    if (
      !window ||
      pagingWindow.current === window ||
      !navigation.isFocused() ||
      !isForeground() ||
      lock.getState().locked
    )
      return;
    pagingWindow.current = window;
    setPaging(true);
    try {
      const anchor = messages.find((item) => visible.has(item._id))?._id;
      if (
        direction === "older" &&
        anchor &&
        snapshot &&
        snapshot.messages.length >= 160
      )
        await window.anchor(anchor);
      await window.page(direction);
      if (direction === "latest") {
        conversations.remember(id, target);
        setJump({ latest: true });
      }
    } catch (reason) {
      showError(reason);
    } finally {
      if (pagingWindow.current === window) {
        pagingWindow.current = undefined;
        setPaging(false);
      }
    }
  }

  function submitAttachment(
    request: AttachmentRequest,
    source: (
      signal: AbortSignal,
    ) => Promise<Parameters<typeof sendMarmotAttachment>[0]["source"]>,
    message?: VoiceSend,
  ) {
    if (!canSendFromWindow() || sendingAttachment.current) return;
    const controller = new AbortController();
    sendingAttachment.current = controller;
    setUpload({ kind: "preparing" });
    if (message) setVoiceSend({ ...message, phase: "uploading" });
    let messageId: string | undefined;
    let unsubscribeForeground: (() => void) | undefined;
    void (async () => {
      await waitForAttachmentForeground(
        { get: isForeground, subscribe: subscribeForeground },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!canDispatch()) return;
      unsubscribeForeground = subscribeForeground(() => {
        if (!isForeground()) controller.abort();
      });
      await draftWrites.current;
      controller.signal.throwIfAborted();
      if (!canDispatch()) return;
      const prepared = await source(controller.signal);
      if (!canDispatch() || controller.signal.aborted) return;
      const accepted = await sendMarmotAttachment({
        sdk: mediaSdk,
        group: id,
        ...request,
        source: prepared,
        allowed: canDispatch,
        progress: (fraction) => setUpload({ kind: "uploading", fraction }),
        onStaged:
          message &&
          ((sizes) => {
            setVoiceSend((current) =>
              current?.token === message.token
                ? { ...current, sizes }
                : current,
            );
          }),
        mirrorFailed: () => Alert.alert(t("messages:mediaMirrorFailed")),
        signal: controller.signal,
      });
      messageId = accepted?.id;
      if (
        accepted &&
        !message &&
        !deferredDraft.current &&
        !controller.signal.aborted
      ) {
        setComposer("");
        setReply(null);
      }
    })()
      .catch((reason: unknown) => {
        if (!message && !controller.signal.aborted) showError(reason);
      })
      .finally(() => {
        unsubscribeForeground?.();
        if (sendingAttachment.current === controller) {
          sendingAttachment.current = undefined;
          setUpload(undefined);
          if (message)
            setVoiceSend((current) =>
              current?.token === message.token
                ? {
                    ...current,
                    messageId,
                    phase: messageId === undefined ? "failed" : "accepted",
                  }
                : current,
            );
        }
      });
  }

  function submitVoice(message: VoiceSend) {
    if (
      busy ||
      (pendingMedia &&
        (pendingMedia.kind !== "ready" || pendingMedia.token !== message.token))
    )
      return;
    const { file, sizes } = message;
    if (sizes)
      submitAttachment(
        message,
        async () => ({ kind: "draft", sizes }),
        message,
      );
    else if (file)
      submitAttachment(
        message,
        async () => ({ kind: "files", files: [file], saveDraft: true }),
        message,
      );
  }

  function discardVoice(message: VoiceSend) {
    if (busy || sendingAttachment.current || !canDispatch()) return;
    setBusy(true);
    void (async () => {
      if (
        pendingMedia?.kind === "ready" &&
        pendingMedia.token === message.token
      )
        await marmot.discardMediaDraft(id);
      setVoiceSend(undefined);
    })()
      .catch(showError)
      .finally(() => setBusy(false));
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
            const audio = file.type.startsWith("audio/");
            const imageFile = file.type.startsWith("image/");
            if (!video && !audio && !imageFile) return file;
            let poster: File | undefined;
            let prepared = file;
            try {
              if (
                video ||
                (audio && !file.duration) ||
                (imageFile && !file.dimensions)
              ) {
                const info = await marmot.inspectMediaFile(
                  file.path,
                  imageFile,
                  video && !file.thumbhash,
                );
                if (info.path) poster = new File(localMediaUri(info.path));
                prepared = {
                  ...file,
                  dimensions: file.dimensions ?? info.dimensions ?? undefined,
                  duration:
                    file.duration ??
                    (info.duration == null ? undefined : String(info.duration)),
                };
              }
              signal.throwIfAborted();
              if (file.thumbhash || (!imageFile && !poster)) return prepared;
              const image = await Image.loadAsync(
                poster?.uri ?? localMediaUri(file.path),
                {
                  maxWidth: 96,
                  maxHeight: 96,
                },
              );
              return {
                ...prepared,
                thumbhash: await Image.generateThumbhashAsync(image),
              };
            } catch {
              signal.throwIfAborted();
              return prepared;
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

  function openGroupDetails() {
    if (!snapshot || snapshot.invited || !navigation.isFocused() || locked)
      return;
    const route = conversationRoute(id, "details");
    router.push({
      ...route,
      params: {
        ...route.params,
        origin: `group:${id}`,
      },
    });
  }

  if (error)
    return (
      <Screen navigationHeader={<ScreenHeader title={title} />}>
        <Empty detail="" icon="chat" title={t("messages:marmot.accountError")}>
          <Action onPress={retry}>{t("common:retry")}</Action>
        </Empty>
      </Screen>
    );
  if (!snapshot)
    return (
      <Screen scroll={false} navigationHeader={<ScreenHeader title={title} />}>
        <View style={styles.syncing}>
          <LoadingStatus label={t("messages:marmot.openingChat")} />
        </View>
      </Screen>
    );

  const menu = [
    { id: "search", title: t("messages:marmot.searchConversation") },
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

  const header = (
    <View style={[styles.header, { direction: kit.rtl ? "rtl" : "ltr" }]}>
      <GlassBackButton
        elevation="none"
        onPress={
          searching
            ? closeSearch
            : () => {
                if (router.canGoBack()) router.back();
                else router.replace("/");
              }
        }
      />
      {searching ? (
        <View style={styles.headerIdentity}>
          <Search
            accessibilityLabel={searchLabel}
            placeholder={searchLabel}
            value={searchQuery}
            onChangeText={setSearchQuery}
            maxLength={128}
            autoFocus={panel === "search"}
          />
        </View>
      ) : (
        <>
          <GlassSurface
            preset="control"
            elevation="none"
            tint={material.panel}
            style={[styles.headerCapsule, styles.headerIdentity]}
          >
            {snapshot.invited ? (
              <Ink
                kind="heading"
                numberOfLines={1}
                style={styles.invitationTitle}
              >
                {title}
              </Ink>
            ) : (
              <Transition.Boundary
                id={peer ? `person:${peer}` : `group:${id}`}
                accessibilityRole="button"
                accessibilityLabel={title}
                style={styles.profileLink}
                onPress={() => {
                  tapFeedback();
                  if (peer) {
                    router.push({
                      pathname: "/person/[key]",
                      params: { key: peer, origin: `person:${peer}` },
                    });
                  } else openGroupDetails();
                }}
              >
                <Transition.Boundary.Target>
                  <GlassAvatar
                    size="md"
                    name={title}
                    src={peer ? avatar : groupAvatar}
                  />
                </Transition.Boundary.Target>
                <Ink
                  kind="heading"
                  numberOfLines={1}
                  style={styles.profileName}
                >
                  {title}
                </Ink>
              </Transition.Boundary>
            )}
          </GlassSurface>
          {!snapshot.invited && (
            <GlassSurface
              preset="control"
              elevation="none"
              tint={material.panel}
              style={[styles.headerCapsule, styles.headerActions]}
            >
              {peer && !blocked && (
                <>
                  <IconButton
                    icon="phone"
                    label={t("messages:call")}
                    tone="plain"
                    onPress={() => {
                      if (!privacy.isBlocked(peer))
                        router.push({
                          pathname: "/call/[key]",
                          params: { key: peer },
                        });
                    }}
                  />
                  <IconButton
                    icon="camera"
                    label={t("messenger:video")}
                    tone="plain"
                    onPress={() => {
                      if (!privacy.isBlocked(peer))
                        router.push({
                          pathname: "/call/[key]",
                          params: { key: peer, video: "1" },
                        });
                    }}
                  />
                </>
              )}
              {!peer && canSend && (
                <GroupCallHeaderButton
                  canDispatch={() => navigation.isFocused() && canDispatch()}
                />
              )}
              <ActionMenu
                label={t("messages:marmot.chatOptions")}
                actions={menu}
                onSelect={selectMenuAction}
              >
                <View style={styles.menuButton}>
                  <View style={styles.verticalMenu}>
                    <Icon name="more" color={kit.colors.text} />
                  </View>
                </View>
              </ActionMenu>
            </GlassSurface>
          )}
        </>
      )}
    </View>
  );

  return (
    <ScreenInsets
      edges={["top", "left", "right"]}
      style={[styles.screen, { backgroundColor: kit.colors.background }]}
    >
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
      <View
        style={[styles.chrome, { transform: [{ translateY: chromeOffset }] }]}
      >
        {chromeOffset > 0 && (
          <View
            style={[
              StyleSheet.absoluteFill,
              { top: -chromeOffset, backgroundColor: kit.colors.background },
            ]}
          />
        )}
        {!peer && !searching && canSend ? (
          <MarmotActiveCall
            group={id}
            members={mentionRoster.members}
            canStart
            header={header}
          />
        ) : (
          header
        )}
        {snapshot.invited && (
          <MarmotInvitation
            id={id}
            direct={Boolean(peer)}
            busy={busy}
            setBusy={setBusy}
          />
        )}
        {!snapshot.invited && (
          <>
            {upload && voiceSend?.phase !== "uploading" && (
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
            {!upload && pendingMedia && !recoveredVoice && canSend && (
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
                          sizes: pendingMedia.sizes,
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
              <Action size="sm" onPress={() => void page("latest")}>
                {t("messages:latest")}
              </Action>
            )}
          </>
        )}
      </View>
      {!snapshot.invited && (
        <>
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
              messages={displayed}
              chatRef={chatRef}
              highlightText={highlight}
              user={{ _id: self }}
              mediaPlayback={{
                isAutoPlayNextEnabled: false,
                isRoundVideoAutoplayEnabled: false,
                isFloatingRoundNoteEnabled: false,
                isNowPlayingBarEnabled: false,
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
              renderBubble={(props) => {
                const row = props.currentMessage?.row;
                return (
                  <Bubble
                    {...props}
                    renderTicks={
                      row?.sender === self && delivery(row) === "received"
                        ? () => (
                            <View
                              accessible
                              accessibilityLabel={t(
                                "messages:marmot.recipientConfirmed",
                              )}
                              style={styles.recipientConfirmation}
                            >
                              <Icon
                                name="check"
                                size={10}
                                color={kit.theme.colors?.outgoingMeta}
                              />
                            </View>
                          )
                        : props.renderTicks
                    }
                  />
                );
              }}
              renderMessageText={(props) => (
                <PreparedMessageText
                  {...props}
                  names={mentionNames}
                  content={
                    props.currentMessage.row?.text === props.currentMessage.text
                      ? props.currentMessage.row?.content
                      : undefined
                  }
                />
              )}
              renderInputToolbar={(props) =>
                canSend ? (
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
                  <Ink>
                    {t(
                      blockState.status === "ready"
                        ? "messages:marmot.blocked"
                        : "security:blockedUnavailable",
                    )}
                  </Ink>
                ) : null
              }
              onDraftChange={(text) => {
                saveDraft(text, reply?._id ?? null);
              }}
              listProps={{
                onViewableItemsChanged: onVisible,
                onScrollEndDrag: rememberScroll,
                onMomentumScrollEnd: rememberScroll,
                dataKey: snapshot.generation,
                onReady: () => {
                  if (readyGeneration.current === snapshot.generation) return;
                  readyGeneration.current = snapshot.generation;
                  messagingMetric("conversation list ready", {
                    cached: opening.cached,
                    ms: performance.now() - opening.at,
                  });
                },
                // Keep the oldest message reachable under the player chrome.
                contentContainerStyle: { paddingTop: playerClearance },
                ...(initialScrollOffset !== undefined
                  ? {
                      initialScrollAtEnd: false,
                      initialScrollOffset,
                    }
                  : initialMessageIndex >= 0 && {
                      initialScrollAtEnd: false,
                      initialScrollIndex: {
                        // Chat Kit presents the inverted message data in reverse order.
                        index: displayed.length - 1 - initialMessageIndex,
                        viewPosition: 0.5,
                      },
                    }),
              }}
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
                isInfiniteScrollEnabled: focused && foreground && !locked,
                onPress: () => void page("older"),
              }}
              onSend={
                canSend
                  ? (batch) => {
                      for (const item of batch) {
                        if (item.audio || item.video) {
                          if (!canCompose) continue;
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
                              file.duration = String(item.duration);
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
                            if (item.audio) {
                              if (!canDispatch() || sendingAttachment.current)
                                continue;
                              submitVoice({
                                token: randomUUID(),
                                caption:
                                  item.text?.trim() ||
                                  (composer ?? snapshot.draft?.text)?.trim() ||
                                  null,
                                reply:
                                  reply?._id ?? snapshot.draft?.replyTo ?? null,
                                createdAt: Date.now(),
                                duration: item.duration,
                                waveform: item.waveform,
                                file,
                                phase: "uploading",
                              });
                              setComposer("");
                              setReply(null);
                            } else sendMedia([file], item.text);
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
              onDeleteMessages={(messages) =>
                requestDeletion(messages.map((message) => message._id))
              }
              onPinMessage={(message) => {
                if (
                  message.row &&
                  !message.row.deleted &&
                  !message.row.system
                ) {
                  chatPreferences.setPin(id, message._id, !message.isPinned);
                }
              }}
              onForwardMessage={(message) => {
                setSelected(message.row);
                setPanel("forward");
              }}
              messageActions={(message, defaults) => {
                if (
                  voice?.phase === "failed" &&
                  message._id === `voice-upload:${voice.token}`
                )
                  return [
                    {
                      key: "discardVoice",
                      label: t("messages:mediaDiscardDraft"),
                      icon: ({ color, size }) => (
                        <Icon name="trash" color={color} size={size} />
                      ),
                      destructive: true,
                      onPress: () => discardVoice(voice),
                    },
                  ];
                const row = message.row;
                if (!row || row.deleted || row.system) return [];
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
                    action.key !== "delete",
                );
                if (row.sourceId && !message.isViewOnce) {
                  for (const item of acceptedAttachments(row)) {
                    const source = presentation.authorize([
                      id,
                      row.id,
                      row.sourceId,
                      item.index,
                    ]);
                    if (!source) continue;
                    const suffix =
                      row.attachments.length > 1 ? ` · ${item.name}` : "";
                    const cached = presentation.hasLocalFile(source.target);
                    if (cached) {
                      for (const action of ["save", "share"] as const) {
                        if (item.voice && action === "share") continue;
                        actions.push({
                          key: `${action}:${item.index}`,
                          label:
                            t(
                              action === "save"
                                ? "messages:mediaSave"
                                : "messages:mediaShare",
                            ) + suffix,
                          icon: ({ color, size }) => (
                            <Icon
                              name={action === "save" ? "download" : "share"}
                              color={color}
                              size={size}
                            />
                          ),
                          onPress: () =>
                            void exportMarmotAttachment(
                              presentation,
                              source.target,
                              item,
                              action,
                            ).catch(() =>
                              Alert.alert(t("messages:mediaOpenFailed")),
                            ),
                        });
                      }
                    }
                    if (!audioFile(item.name, item.type)) continue;
                    const track = audioTrackForMessage(
                      source,
                      item,
                      message,
                      title,
                      t("messages:voiceMessage"),
                    );
                    if (!track.voice)
                      actions.push({
                        key: `play:${item.index}`,
                        label:
                          t(cached ? "audio:playNow" : "audio:download") +
                          suffix,
                        icon: ({ color, size }) => (
                          <Icon
                            name={cached ? "play" : "download"}
                            color={color}
                            size={size}
                          />
                        ),
                        onPress: () =>
                          void openAudio(track, "internal", !cached),
                      });
                    actions.push(
                      {
                        key: `next:${item.index}`,
                        label: t("audio:playNext") + suffix,
                        icon: ({ color, size }) => (
                          <Icon name="skipNext" color={color} size={size} />
                        ),
                        onPress: () => queueAudio(track, true),
                      },
                      {
                        key: `queue:${item.index}`,
                        label: t("audio:addQueue") + suffix,
                        icon: ({ color, size }) => (
                          <Icon name="addToQueue" color={color} size={size} />
                        ),
                        onPress: () => queueAudio(track),
                      },
                    );
                    if (!track.voice && cached)
                      actions.push({
                        key: `external:${item.index}`,
                        label: t("audio:external") + suffix,
                        icon: ({ color, size }) => (
                          <Icon name="openExternal" color={color} size={size} />
                        ),
                        onPress: () => void openAudio(track, "external"),
                      });
                  }
                }
                if (row.edited)
                  actions.push({
                    key: "editHistory",
                    label: t("messages:editHistory"),
                    icon: ({ color, size }) => (
                      <Icon name="history" color={color} size={size} />
                    ),
                    onPress() {
                      setSelected(row);
                      setPanel("edits");
                    },
                  });
                if (canSend && !peer && row.sender !== self)
                  actions.push({
                    key: "report",
                    label: t("messages:marmot.reportMessage"),
                    icon: ({ color, size }) => (
                      <Icon name="report" color={color} size={size} />
                    ),
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
                  key: "delete",
                  label: t("chatKit:labels.actionDelete"),
                  icon: ({ color, size }) => (
                    <Icon name="trash" color={color} size={size} />
                  ),
                  destructive: true,
                  onPress: () => requestDeletion([row.id]),
                });
                return actions;
              }}
              onRetryMessage={
                canSend
                  ? (message) => {
                      if (
                        voice?.phase === "failed" &&
                        message._id === `voice-upload:${voice.token}`
                      )
                        submitVoice(voice);
                      else run(() => marmot.retryConversation(id));
                    }
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
                renderReactions: ({
                  message,
                  onReactionPress,
                  containerStyle,
                  reactionStyle,
                  reactionActiveStyle,
                  reactionCountStyle,
                  reactionTextStyle,
                }) => (
                  <View style={[styles.reactionCounts, containerStyle]}>
                    {message.row?.reactions.map(({ emoji, count, own }) => (
                      <Pressable
                        key={emoji}
                        style={[
                          styles.reactionCount,
                          reactionStyle,
                          own && reactionActiveStyle,
                        ]}
                        accessibilityRole="button"
                        accessibilityState={{
                          selected: own,
                          disabled: !onReactionPress,
                        }}
                        disabled={!onReactionPress}
                        onPress={() => onReactionPress?.(emoji)}
                      >
                        <Ink style={reactionTextStyle}>{emoji}</Ink>
                        <Ink style={reactionCountStyle}>{count}</Ink>
                      </Pressable>
                    ))}
                  </View>
                ),
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
                if (
                  voice &&
                  currentMessage?._id === `voice-upload:${voice.token}`
                )
                  return (
                    <VoiceUploadAttachment
                      message={currentMessage}
                      duration={voice.duration}
                      waveform={voice.waveform}
                      progress={
                        voice.phase === "accepted"
                          ? 1
                          : upload?.kind === "uploading"
                            ? upload.fraction
                            : 0
                      }
                      retry={
                        voice.phase === "failed"
                          ? () => submitVoice(voice)
                          : undefined
                      }
                    />
                  );
                const row = currentMessage?.row;
                if (!row || row.deleted) return null;
                const failedVoice =
                  row.invalidationStatus &&
                  row.sender === self &&
                  acceptedAttachments(row).find((item) => item.voice);
                if (failedVoice)
                  return (
                    <VoiceUploadAttachment
                      message={currentMessage}
                      duration={failedVoice.duration ?? undefined}
                      waveform={failedVoice.waveform ?? undefined}
                      progress={0}
                      retry={() => run(() => marmot.retryConversation(id))}
                    />
                  );
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
                  keepChatWindow && !locked && !blocked ? (
                    <MarmotAttachments
                      group={id}
                      conversation={title}
                      row={row}
                      message={currentMessage}
                      presentation={presentation}
                      gallery={gallery}
                      foreground={focused && foreground}
                      visible={focused && foreground && visible.has(row.id)}
                    />
                  ) : null
                ) : row.eventKind === 9 || row.eventKind === 1111 ? (
                  <>
                    <MarmotLink
                      group={id}
                      id={row.id}
                      body={row.text}
                      author={row.sender}
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
              audioRecording={{
                isEnabled: canCompose,
                isViewOnceEnabled: false,
                canUseAudioSession: () => {
                  const call = calling.store.getState().call;
                  return !call || call.phase === "ended";
                },
                canReleaseAudioSession: () => {
                  const call = calling.store.getState().call;
                  return !call || call.phase === "ended";
                },
                onAudioSessionChange: (active) =>
                  audio.recording(active, audioSessionOwner),
                onActiveChange: recordingChanged,
              }}
              videoRecording={{
                isEnabled: canCompose,
                isViewOnceEnabled: false,
              }}
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
  const { privacy, db, identity, isCurrent, lock } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const translateError = useMarmotError();
  const [loaded, setLoaded] = useState<{
    group: string;
    account: string;
    preview: MarmotGroupInvitation;
  }>();
  const invitation =
    loaded?.group === id && loaded.account === identity.publicKey
      ? loaded.preview
      : undefined;
  useEffect(() => {
    let active = true;
    void marmot
      .groupInvitation(id, true)
      .then((preview) => {
        if (active && isCurrent())
          setLoaded({ group: id, account: identity.publicKey, preview });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [id, identity.publicKey, isCurrent]);
  const inviter = invitation?.inviter;
  const permission = inviter ? privacy.messagePermission(inviter) : undefined;
  const allowed = permission === "allow" || permission === "request";
  const name =
    inviter && allowed
      ? (contactByKey(db, inviter).get()?.name ?? toNpub(inviter))
      : null;
  const participantNames = invitation?.members
    .filter((member) => !privacy.isBlocked(member.id))
    .slice(0, 4)
    .map((member) => member.name || member.npub.slice(0, 15) + "…")
    .join(", ");
  function respond(accept: boolean, block = false) {
    if (busy) return;
    const current = inviter ? privacy.messagePermission(inviter) : undefined;
    if (accept && current !== "allow" && current !== "request") return;
    setBusy(true);
    void (async () => {
      if (!isCurrent() || lock.getState().locked) return;
      if (block && inviter) {
        await privacy.blocks.block(inviter);
        if (!isCurrent() || lock.getState().locked) return;
      }
      if (accept) {
        const latest = await marmot.groupInvitation(id);
        if (!isCurrent() || lock.getState().locked || !inviter) return;
        if (latest.inviter !== inviter) {
          setLoaded(undefined);
          Alert.alert(t("messages:marmot.inviteGone"));
          return;
        }
        const permission = privacy.messagePermission(inviter);
        if (permission !== "allow" && permission !== "request") return;
      }
      await marmot.respondToInvitation(id, accept);
      if (!isCurrent()) return;
      if (accept && direct && inviter) privacy.approveInvitation(inviter);
      else if (!accept) router.back();
    })()
      .catch((reason) => Alert.alert(translateError(reason)))
      .finally(() => setBusy(false));
  }
  return (
    <View style={styles.invitation}>
      <Ink>
        {t(
          !privacy.blocks.ready()
            ? "security:blockedUnavailable"
            : permission === "blocked"
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
      {allowed && !direct && invitation && invitation.memberCount > 0 && (
        <Ink kind="caption">
          {t("messages:marmot.members")} ({invitation.memberCount})
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
        <Action disabled={busy} onPress={() => respond(false, true)}>
          {t("messages:marmot.blockInviter")}
        </Action>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  recipientConfirmation: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#E5EBFF",
  },
  reactionCounts: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  reactionCount: { flexDirection: "row", alignItems: "center", gap: space.xs },
  uploadStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.md,
  },
  screen: { flex: 1 },
  chrome: { zIndex: 1 },
  syncing: { flex: 1, justifyContent: "center" },
  contours: { width: "100%", height: "100%", opacity: 0.25 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    zIndex: 1,
    marginHorizontal: space.sm,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  headerCapsule: { minHeight: 44, borderRadius: radius.round },
  headerIdentity: { flex: 1, minWidth: 0, justifyContent: "center" },
  profileLink: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: space.sm,
    paddingStart: 2,
    paddingEnd: space.md,
  },
  profileName: { flex: 1, fontSize: 16 },
  invitationTitle: { paddingHorizontal: space.md, fontSize: 16 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  menuButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  verticalMenu: { transform: [{ rotate: "90deg" }] },
  chat: { flex: 1 },
  invitation: { padding: space.md, gap: space.sm },
});
