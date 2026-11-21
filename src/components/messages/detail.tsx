import { randomUUID } from "expo-crypto";
import { isUploadFailure } from "@/core/media/blossom";
import { voiceRecordingPrefix } from "@/core/media/files";
import { File } from "expo-file-system";
import {
  maxVoiceDuration,
  minVoiceDuration,
  voiceMime,
} from "@/core/media/protocol";
import { VoiceMessage } from "./voice-message";
import { useAvatar } from "@/core/avatars/use-avatar";
import {
  Bubble,
  Chat,
  type ChatHandle,
  ChatHeader,
  type ChatProps,
  Composer,
  InputToolbar,
  type MessageActionKey,
  type MessageMenuItem,
  MessageText,
  type ReplyMessage,
  Send,
  type SendProps,
  Time,
} from "@kesha-antonov/react-native-chat";
import { setStringAsync } from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import {
  type ComponentProps,
  type ComponentRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AppState,
  BackHandler,
  Dimensions,
  Image,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Action, Icon, IconButton, Ink } from "@/components/ui/kit";
import { useBlockAction } from "@/components/ui/privacy-actions";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { nameOrAddress, useContact } from "@/db/contacts";
import type { MessageCursor } from "@/db/messaging";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { useLocal } from "@/services/local";
import { radius, space } from "@/theme";
import { conversationMaterials, useChatAppearance } from "./appearance";
import { type DetailMessage, toQuote } from "./detail-adapter";
import { useDetailHistory } from "./detail-history";
import {
  OpenLaterSheet,
  type SendMenuAnchor,
  SpecialSendMenu,
} from "./send-options";
import { canRetryUnlock, LockedMessageBubble } from "./timelock-message";
import { useMessageTranslations } from "./use-message-translations";

const messageActions: MessageActionKey[] = [
  "reply",
  "copy",
  "select",
  "delete",
];
const viewabilityConfig = {
  id: "boop-read-receipts-local",
  minimumViewTime: 250,
  viewAreaCoveragePercentThreshold: 5,
};
const autoText = { textAlign: "auto", writingDirection: "auto" } as const;
const emptySendSlot = () => null;
function discardVoiceRecording(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // The recording is in the platform cache.
  }
}
const renderTranslatedText: NonNullable<
  ChatProps<DetailMessage>["renderMessageText"]
> = (props) => <MessageText {...props} url={false} />;

function useStressArrival(peerKey: string) {
  const { t } = useTranslation(namespaces);
  const { chat, identity } = useLocal();
  const [factory, setFactory] =
    useState<typeof import("@/db/chat-stress").stressArrival>();
  const [scheduled, setScheduled] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!__DEV__) return;
    let mounted = true;
    void import("@/db/chat-stress").then((module) => {
      if (mounted && peerKey === module.stressPeerKey) {
        setFactory(() => module.stressArrival);
      }
    });
    return () => {
      mounted = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [peerKey]);
  const schedule = useCallback(() => {
    if (!factory || timer.current) return;
    setScheduled(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setScheduled(false);
      try {
        chat.receive(factory(identity.publicKey));
      } catch {
        Alert.alert(t("messages:testMessageError"));
      }
    }, 4_000);
  }, [chat, factory, identity.publicKey, t]);
  return { available: Boolean(factory), schedule, scheduled };
}

export function DetailConversation({ peerKey }: { peerKey: string }) {
  const blockAction = useBlockAction(peerKey);
  const { blocked } = blockAction;
  const [openedAt] = useState(() => (__DEV__ ? performance.now() : 0));
  const measuredFirstMessages = useRef(false);
  const { t } = useTranslation(namespaces);
  const { chat, identity, messaging, history, conversations, lock, calling } =
    useLocal();
  const {
    available: stressEnabled,
    scheduled,
    schedule,
  } = useStressArrival(peerKey);
  const contact = useContact(peerKey);
  const name = nameOrAddress(contact?.name, peerKey);
  const avatar = useAvatar(peerKey);
  const focused = useIsFocused();
  const callActive = useCallback(() => {
    const call = calling.store.getState().call;
    return Boolean(call && call.phase !== "ended");
  }, [calling]);
  const inCall = useSyncExternalStore(calling.store.subscribe, callActive);
  const activeUnlocked = useSyncExternalStore(lock.subscribe, () => {
    const state = lock.getState();
    return state.active && !state.locked;
  });
  const allowVoice = focused && !blocked && activeUnlocked && !inCall;
  const canUseAudioSession = useCallback(() => {
    const gate = lock.getState();
    const call = calling.store.getState().call;
    return (
      focused &&
      !blocked &&
      gate.active &&
      !gate.locked &&
      (!call || call.phase === "ended")
    );
  }, [focused, blocked, lock, calling]);
  const {
    theme,
    darkTheme,
    appearance,
    colorScheme,
    locale,
    labels,
    icons,
    rtl,
    colors,
    reducedMotion,
    reducedTransparency,
  } = useChatAppearance(true);
  const material = conversationMaterials[colorScheme];
  const kit = useMemo(
    () => ({
      theme,
      darkTheme,
      appearance,
      colorScheme,
      locale,
      labels: {
        ...labels,
        actionDelete: t("messages:deleteLocal"),
        send: t("messages:send"),
      },
      icons,
    }),
    [theme, darkTheme, appearance, colorScheme, locale, labels, icons, t],
  );
  const participants = useMemo(
    () => ({
      self: { _id: identity.publicKey, name: t("messages:self") },
      peer: { _id: peerKey, name, avatar: avatar },
    }),
    [identity.publicKey, peerKey, name, t, avatar],
  );
  const resolveUser = useCallback(
    (id: string | number) =>
      id === participants.self._id
        ? participants.self
        : id === participants.peer._id
          ? participants.peer
          : undefined,
    [participants],
  );
  const status = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getStatus,
    messaging.getStatus,
  );
  const {
    items,
    error,
    older,
    newer,
    extend,
    olderPage,
    loadAround,
    loadLatest,
    retry,
    firstUnreadMessageId,
    restoredMessageId,
    initiallyDetached,
  } = useDetailHistory(
    chat,
    history,
    peerKey,
    participants,
    t("messages:unavailableQuote"),
    t("messages:lockedMessage"),
    t("messages:voiceMessage"),
  );
  const [detached, setDetached] = useState(initiallyDetached);
  const positioned =
    firstUnreadMessageId !== null || restoredMessageId !== undefined;
  const [atLatest, setAtLatest] = useState(!positioned);
  const latestPosition = useRef(!positioned);
  const [loadingPage, startPage] = useTransition();
  const [jump, setJump] = useState<{ id: string; highlight: boolean }>();
  const [notice, setNotice] = useState<string>();
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const visibleUnread = useRef<string[]>([]);
  const readingPosition = useRef<MessageCursor>(undefined);
  const {
    displayed,
    missing,
    failed,
    retry: retryTranslation,
    toggleOriginal,
    refresh,
  } = useMessageTranslations(items, visibleIds, locale, focused && !blocked);
  const renderTranslatedBubble = useCallback<
    NonNullable<ChatProps<DetailMessage>["renderBubble"]>
  >(
    (props) => {
      const message = props.currentMessage;
      if (message?.voice) {
        return (
          <Bubble
            {...props}
            renderCustomView={() => (
              <VoiceMessage
                key={message._id}
                message={message}
                peer={peerKey}
                enabled={allowVoice}
                rtl={rtl}
                color={
                  message.direction === "outgoing"
                    ? colors.outgoingInk
                    : colors.text
                }
              />
            )}
          />
        );
      }
      if (message?.locked) {
        const sealed = message.locked;
        return (
          <Bubble
            {...props}
            renderCustomView={() => (
              <LockedMessageBubble
                lock={sealed}
                color={
                  props.position === "right" ? colors.outgoingInk : colors.text
                }
                rtl={rtl}
              />
            )}
          />
        );
      }
      if (message?.originalText === undefined) {
        if (!message?.timeLock || reducedMotion) return <Bubble {...props} />;
        return (
          <Bubble
            {...props}
            renderMessageText={(textProps) => (
              <Animated.View entering={FadeIn.duration(180)}>
                <MessageText {...textProps} />
              </Animated.View>
            )}
          />
        );
      }
      const original = message.text === message.originalText;
      return (
        <Bubble
          {...props}
          renderMessageText={original ? undefined : renderTranslatedText}
          renderTime={(timeProps) => (
            <View
              style={[styles.translationMeta, rtl && styles.translationMetaRtl]}
            >
              <Pressable
                accessibilityRole="link"
                hitSlop={6}
                onPress={() => toggleOriginal(message._id)}
              >
                <Text
                  style={[
                    styles.translationLink,
                    {
                      color:
                        props.position === "right"
                          ? colors.outgoingInk
                          : colors.accent,
                    },
                  ]}
                >
                  {t(
                    original
                      ? "translation:showTranslation"
                      : "translation:showOriginal",
                  )}
                </Text>
              </Pressable>
              <Time {...timeProps} />
            </View>
          )}
        />
      );
    },
    [
      allowVoice,
      peerKey,
      colors.accent,
      colors.outgoingInk,
      colors.text,
      reducedMotion,
      rtl,
      t,
      toggleOriginal,
    ],
  );
  const [initialDraft] = useState(() => {
    try {
      const saved = chat.draft(peerKey);
      const target = saved?.draftReplyTo
        ? chat.message(peerKey, saved.draftReplyTo)
        : undefined;
      const quote = target
        ? toQuote(
            target,
            participants,
            t("messages:lockedMessage"),
            t("messages:voiceMessage"),
          )
        : null;
      return { text: saved?.draft ?? "", quote };
    } catch {
      return { text: "", quote: null };
    }
  });
  const [draft, setDraft] = useState(initialDraft.text);
  const [quote, setQuote] = useState<ReplyMessage | null>(initialDraft.quote);
  const composition = useRef(initialDraft);
  const [sending, setSending] = useState(false);
  const sendBusy = useRef(false);
  const chatRef = useRef<ChatHandle>(null);
  const textInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const menuHost = useRef<ComponentRef<typeof View>>(null);
  const sendAnchor = useRef<ComponentRef<typeof View>>(null);
  const [menu, setMenu] = useState<SendMenuAnchor>();
  const [openLater, setOpenLater] = useState(false);
  const [pickerSession, setPickerSession] = useState(0);
  const clearSpecialInput = useRef<() => void>(undefined);
  const [openError, setOpenError] = useState<string>();
  const restoreInput = useRef(false);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const closeMenu = useCallback(() => setMenu(undefined), []);
  useEffect(() => {
    if (!menu) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      closeMenu();
      return true;
    });
    const keyboardHidden = Keyboard.addListener("keyboardDidHide", closeMenu);
    const keyboardShown = Keyboard.addListener("keyboardDidShow", closeMenu);
    const layout = Dimensions.addEventListener("change", closeMenu);
    return () => {
      back.remove();
      keyboardHidden.remove();
      keyboardShown.remove();
      layout.remove();
    };
  }, [menu, closeMenu]);
  useFocusEffect(useCallback(() => closeMenu, [closeMenu]));
  useEffect(() => () => clearTimeout(focusTimer.current), []);

  const showMenu = useCallback((reset: () => void) => {
    const host = menuHost.current;
    if (!host || !composition.current.text.trim() || sendBusy.current) return;
    host.measureInWindow((rootX, rootY, available, rootHeight) => {
      sendAnchor.current?.measureInWindow((x, y, width) => {
        if (available > 32 && rootHeight > 0 && width > 0) {
          clearSpecialInput.current = reset;
          setMenu({
            x: x - rootX,
            y: Math.max(0, rootY + rootHeight - y),
            width,
            available,
          });
        }
      });
    });
  }, []);

  const showOpenLater = useCallback(() => {
    closeMenu();
    restoreInput.current = Boolean(textInputRef.current?.isFocused());
    Keyboard.dismiss();
    setOpenError(undefined);
    setPickerSession((session) => session + 1);
    setOpenLater(true);
  }, [closeMenu]);

  const cancelOpenLater = useCallback(() => {
    setOpenLater(false);
    if (restoreInput.current) {
      clearTimeout(focusTimer.current);
      focusTimer.current = setTimeout(() => textInputRef.current?.focus(), 360);
    }
    restoreInput.current = false;
  }, []);

  const pendingDraft = useRef<{ text: string; reply: string | null } | null>(
    null,
  );
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (!pendingDraft.current) return;
    try {
      const { text, reply } = pendingDraft.current;
      if (text || reply || chat.draft(peerKey)) {
        chat.saveDraft(peerKey, text, reply);
      }
      pendingDraft.current = null;
    } catch {
      setNotice(t("messages:updateError"));
    }
  }, [chat, peerKey, t]);

  const saveDraft = useCallback(
    (text: string, reply: ReplyMessage | null) => {
      pendingDraft.current = { text, reply: reply ? String(reply._id) : null };
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(flushDraft, 200);
    },
    [flushDraft],
  );

  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") flushDraft();
      });
      return () => {
        subscription.remove();
        flushDraft();
      };
    }, [flushDraft]),
  );

  const updateText = useCallback(
    (value: string) => {
      if (sendBusy.current) return;
      composition.current = { ...composition.current, text: value };
      setDraft(value);
      saveDraft(value, composition.current.quote);
      setNotice(undefined);
    },
    [saveDraft],
  );

  const updateQuote = useCallback(
    (value: ReplyMessage | null) => {
      if (sendBusy.current) return;
      composition.current = { ...composition.current, quote: value };
      setQuote(value);
      saveDraft(composition.current.text, value);
    },
    [saveDraft],
  );

  const sendText = useCallback(
    async (text: string, clearInput: () => void, unlockAt?: number) => {
      if (sendBusy.current || !text.trim()) return;
      sendBusy.current = true;
      flushDraft();
      setSending(true);
      setNotice(undefined);
      try {
        const reply = composition.current.quote;
        await messaging.send({
          peerKey,
          body: text,
          unlockAt,
          replyTo: reply ? String(reply._id) : null,
        });
        // The service clears the persisted draft in the message insert transaction.
        pendingDraft.current = null;
        clearInput();
        composition.current = { text: "", quote: null };
        setDraft("");
        setQuote(null);
        setDetached(false);
      } catch (error) {
        const code = error instanceof Error ? error.message : undefined;
        const message =
          code === "unavailable-reply"
            ? t("messages:sendReplyError")
            : unlockAt === undefined
              ? t("messages:sendError")
              : code === "unlock-time"
                ? t("messages:openTimeError")
                : code === "invalid-message"
                  ? t("messages:invalidMessage")
                  : t("messages:openSendError");
        if (unlockAt === undefined) setNotice(message);
        else setOpenError(message);
        return;
      } finally {
        sendBusy.current = false;
        setSending(false);
      }
      if (unlockAt !== undefined) setOpenLater(false);
      try {
        const id = loadLatest();
        if (id) setJump({ id, highlight: false });
      } catch {
        setNotice(t("messages:historyError"));
      }
    },
    [messaging, peerKey, flushDraft, loadLatest, t],
  );

  // Keep the built-in button, and clear the controlled composer only after SQLite commits.
  const renderSend = useCallback(
    (props: SendProps<DetailMessage>) => {
      const enabled = !sending && !openLater && Boolean(props.text?.trim());
      const clear = () => props.onSend?.([], true);
      const show = () => showMenu(clear);
      return (
        <View ref={sendAnchor} collapsable={false}>
          <Send
            {...props}
            isSendButtonAlwaysVisible
            containerStyle={rtl ? styles.rtlSend : styles.send}
            sendButtonProps={{
              ...props.sendButtonProps,
              hitSlop: 6,
              accessibilityLabel: t("messages:send"),
              onLongPress: enabled ? show : undefined,
              accessibilityActions: enabled
                ? [{ name: "special-send", label: t("messages:openLater") }]
                : undefined,
              onAccessibilityAction: (event) => {
                if (enabled && event.nativeEvent.actionName === "special-send")
                  show();
              },
              accessibilityState: { disabled: !enabled, busy: sending },
              enabled,
            }}
            onSend={(value) => {
              const message = Array.isArray(value) ? value[0] : value;
              if (enabled && message?.text) {
                void sendText(message.text, clear);
              }
            }}
          >
            <View
              style={[
                styles.sendGlyph,
                {
                  backgroundColor: enabled
                    ? material.outgoing[0]
                    : colors.accentSoft,
                },
              ]}
            >
              <Icon
                name="send"
                size={19}
                color={enabled ? colors.outgoingInk : colors.muted}
              />
            </View>
          </Send>
        </View>
      );
    },
    [colors, t, material.outgoing, rtl, sendText, sending, showMenu, openLater],
  );

  const renderComposer = useCallback(
    (props: ComponentProps<typeof Composer>) => (
      <View style={[styles.composerControls, rtl && styles.rtlControls]}>
        <Composer {...props} />
        {props.text?.trim()
          ? renderSend({ text: props.text, onSend: props.onSend })
          : null}
      </View>
    ),
    [renderSend, rtl],
  );

  const onSendVoice = useCallback<
    NonNullable<ChatProps<DetailMessage>["onSend"]>
  >(
    (messages) => {
      const take = messages[0];
      if (!take?.audio) return;
      const uri = take.audio;
      if (!canUseAudioSession() || sendBusy.current) {
        discardVoiceRecording(uri);
        return;
      }
      sendBusy.current = true;
      flushDraft();
      setSending(true);
      setNotice(undefined);
      const samples = take.waveform;
      const waveform = samples?.length
        ? Array.from({ length: Math.min(64, samples.length) }, (_, i) => {
            const width = samples.length / Math.min(64, samples.length);
            const bucket = samples.slice(
              Math.floor(i * width),
              Math.floor((i + 1) * width),
            );
            return Math.round(Math.max(0, Math.min(1, ...bucket)) * 100);
          })
        : undefined;
      const target = take.replyMessage ?? composition.current.quote;
      void messaging
        .sendVoice({
          peerKey,
          uri,
          replyTo: target ? String(target._id) : null,
          voice: {
            kind: "voice",
            mime: voiceMime,
            durationMs: Math.round((take.duration ?? 0) * 1_000),
            waveform,
          },
        })
        .then(() => {
          pendingDraft.current = null;
          composition.current = { text: "", quote: null };
          setQuote(null);
          setDetached(false);
          const id = loadLatest();
          if (id) setJump({ id, highlight: false });
        })
        .catch(() => {
          setNotice(t("messages:voiceRecordingFailed"));
          if (target) {
            composition.current = { ...composition.current, quote: target };
            setQuote(target);
            saveDraft(composition.current.text, target);
          }
        })
        .finally(() => {
          sendBusy.current = false;
          setSending(false);
        });
    },
    [
      canUseAudioSession,
      flushDraft,
      messaging,
      peerKey,
      loadLatest,
      saveDraft,
      t,
    ],
  );

  const audioRecording = useMemo<ChatProps<DetailMessage>["audioRecording"]>(
    () =>
      !allowVoice || sending
        ? false
        : {
            isEnabled: true,
            minDurationMs: minVoiceDuration,
            maxDurationMs: maxVoiceDuration,
            previewAtLimit: true,
            canUseAudioSession,
            canReleaseAudioSession: () => !callActive(),
            recordingFileName: () => `${voiceRecordingPrefix}${randomUUID()}`,
            onDiscardRecording: discardVoiceRecording,
            onPermissionDenied: () =>
              Alert.alert(
                t("messages:voiceMessage"),
                t("messages:voiceMicrophone"),
                [
                  { text: t("common:cancel"), style: "cancel" },
                  {
                    text: t("security:permissions"),
                    onPress: () => {
                      void Linking.openSettings();
                    },
                  },
                ],
              ),
            onTooShort: () => setNotice(t("messages:voiceTooShort")),
            onError: () => setNotice(t("messages:voiceRecordingFailed")),
          },
    [allowVoice, sending, t, canUseAudioSession, callActive],
  );
  const mediaPlayback = useMemo<ChatProps<DetailMessage>["mediaPlayback"]>(
    () => ({
      isAutoPlayNextEnabled: false,
      isNowPlayingBarEnabled: true,
      onMediaRead: (message) => chat.markListened(peerKey, String(message._id)),
    }),
    [chat, peerKey],
  );

  const renderToolbar = useCallback(
    (props: ComponentProps<typeof InputToolbar<DetailMessage>>) => (
      <InputToolbar
        {...props}
        containerStyle={rtl ? styles.rtlToolbar : styles.toolbar}
        replyPreviewContainerStyle={rtl ? styles.rtlReplyPreview : undefined}
        replyPreviewTextStyle={autoText}
      />
    ),
    [rtl],
  );

  const jumpToQuote = useCallback(
    (target: ReplyMessage) => {
      const id = String(target._id);
      setNotice(undefined);
      if (items.some((row) => row._id === id)) {
        chatRef.current?.scrollToMessage(id, {
          animated: !reducedMotion,
          isHighlighted: true,
        });
        return;
      }
      try {
        const row = chat.message(peerKey, id);
        if (!row) {
          setNotice(t("messages:unavailableQuote"));
          return;
        }
        loadAround(row);
        setDetached(true);
        setJump({ id: row.id, highlight: true });
      } catch {
        setNotice(t("messages:historyError"));
      }
    },
    [chat, t, items, loadAround, peerKey, reducedMotion],
  );

  useLayoutEffect(() => {
    if (!jump || !items.some((row) => row._id === jump.id)) return;
    const frame = requestAnimationFrame(() => {
      chatRef.current?.scrollToMessage(jump.id, {
        animated: !reducedMotion,
        isHighlighted: jump.highlight,
        viewPosition: jump.highlight ? 0.5 : 1,
      });
      setJump(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [items, jump, reducedMotion]);

  const goLatest = useCallback(() => {
    try {
      const id = loadLatest();
      setDetached(false);
      if (id) setJump({ id, highlight: false });
    } catch {
      setNotice(t("messages:historyError"));
    }
  }, [t, loadLatest]);

  const loadEarlierMessagesProps = useMemo(
    () => ({
      isAvailable: Boolean(older),
      isLoading: loadingPage,
      isInfiniteScrollEnabled: true,
      onPress: () => {
        if (!older || loadingPage) return;
        startPage(() => {
          try {
            olderPage();
          } catch {
            setNotice(t("messages:historyError"));
          }
        });
      },
    }),
    [t, loadingPage, older, olderPage],
  );

  type ListProps = NonNullable<ChatProps<DetailMessage>["listProps"]>;
  const onScroll = useCallback<NonNullable<ListProps["onScroll"]>>(
    ({ nativeEvent }) => {
      const { contentSize, contentOffset, layoutMeasurement } = nativeEvent;
      if (layoutMeasurement.height <= 0) return;
      const nearBottom =
        contentSize.height - layoutMeasurement.height - contentOffset.y <= 24;
      if (nearBottom === latestPosition.current) return;
      latestPosition.current = nearBottom;
      setAtLatest(nearBottom);
    },
    [],
  );
  const markVisibleRead = useCallback(() => {
    const gate = lock.getState();
    if (
      !focused ||
      AppState.currentState !== "active" ||
      !gate.active ||
      gate.locked
    )
      return;
    try {
      chat.markRead(peerKey, visibleUnread.current);
      visibleUnread.current = [];
    } catch {
      setNotice(t("messages:updateError"));
    }
  }, [chat, focused, lock, peerKey, t]);

  useFocusEffect(
    useCallback(() => {
      const state = AppState.addEventListener("change", markVisibleRead);
      const unlock = lock.subscribe(markVisibleRead);
      markVisibleRead();
      return () => {
        state.remove();
        unlock();
        history.remember(
          peerKey,
          latestPosition.current ? null : (readingPosition.current ?? null),
        );
        if (AppState.currentState === "active" && !lock.getState().locked)
          conversations.prefetch();
      };
    }, [conversations, history, lock, markVisibleRead, peerKey]),
  );

  const onViewableItemsChanged = useCallback<
    NonNullable<ListProps["onViewableItemsChanged"]>
  >(
    ({ viewableItems }) => {
      const shown = viewableItems.filter((entry) => entry.isViewable);
      const ids = shown.map(({ item }) => item._id);
      const leading = shown[0]?.item;
      if (__DEV__ && leading && focused && !measuredFirstMessages.current) {
        measuredFirstMessages.current = true;
        messagingMetric("first visible messages", {
          ms: performance.now() - openedAt,
          rows: shown.length,
        });
      }
      if (leading)
        readingPosition.current = {
          id: leading._id,
          sentAt: leading.createdAt,
        };
      visibleUnread.current = shown.flatMap(({ item }) =>
        item.unread ? [item._id] : [],
      );
      if (
        !focused ||
        AppState.currentState !== "active" ||
        lock.getState().locked
      )
        return;
      setVisibleIds((previous) =>
        previous.length === ids.length &&
        previous.every((id, index) => id === ids[index])
          ? previous
          : ids,
      );
      markVisibleRead();
    },
    [focused, lock, markVisibleRead, openedAt],
  );

  useEffect(() => {
    const visible = new Set(visibleIds);
    visibleUnread.current = items.flatMap((item) =>
      item.unread && !item.locked && visible.has(item._id) ? [item._id] : [],
    );
    let current = true;
    queueMicrotask(() => {
      if (current) markVisibleRead();
    });
    return () => {
      current = false;
    };
  }, [items, visibleIds, markVisibleRead]);

  const [restoredIndex] = useState(() =>
    restoredMessageId
      ? items.findIndex(({ _id }) => _id === restoredMessageId)
      : -1,
  );
  useEffect(() => {
    if (newer && atLatest && !detached && !loadingPage && !jump)
      startPage(extend);
  }, [newer, atLatest, detached, loadingPage, jump, extend]);

  const listProps = useMemo<ListProps>(
    () => ({
      ...(restoredIndex >= 0
        ? {
            initialScrollAtEnd: false,
            initialScrollIndex: { index: restoredIndex, viewPosition: 0 },
          }
        : {}),
      viewabilityConfig,
      recycleItems: false,
      onScroll,
      maintainScrollAtEnd:
        atLatest && !detached
          ? {
              animated: !reducedMotion,
              on: { dataAppend: true, itemLayout: true },
            }
          : false,
      maintainScrollAtEndThreshold: 0,
      onViewableItemsChanged,
      onEndReached: () => {
        if (newer && !loadingPage && !jump) startPage(extend);
      },
    }),
    [
      atLatest,
      detached,
      extend,
      jump,
      loadingPage,
      newer,
      onScroll,
      onViewableItemsChanged,
      reducedMotion,
      restoredIndex,
    ],
  );

  const confirmDelete = useCallback(
    (messages: DetailMessage[]) => {
      Alert.alert(t("messages:deleteLocal"), t("messages:deletePrompt"), [
        { text: t("messages:cancel"), style: "cancel" },
        {
          text: t("messages:deleteLocal"),
          style: "destructive",
          onPress: () => {
            try {
              chat.deleteMessages(
                peerKey,
                messages.map((message) => message._id),
              );
            } catch {
              setNotice(t("messages:updateError"));
            }
          },
        },
      ]);
    },
    [chat, t, peerKey],
  );

  const deleteOne = useCallback(
    (message: DetailMessage) => confirmDelete([message]),
    [confirmDelete],
  );
  const retryMessage = useCallback(
    (message: DetailMessage) => {
      try {
        messaging.retry(peerKey, message._id);
      } catch {
        setNotice(t("messages:updateError"));
      }
    },
    [t, messaging, peerKey],
  );

  const actionsForMessage = useCallback(
    (message: DetailMessage, defaults: MessageMenuItem[]) => {
      const original = message.originalText;
      const actions =
        message.locked || message.voice
          ? defaults.filter(({ key }) => key !== "copy")
          : [...defaults];
      if (original !== undefined)
        actions.push(
          {
            key: "translation-copy-original",
            label: t("translation:copyOriginal"),
            onPress: () => {
              void setStringAsync(original).catch(() =>
                setNotice(t("messages:updateError")),
              );
            },
          },
          {
            key: "translation-refresh",
            label: t("translation:refresh"),
            onPress: () => {
              try {
                refresh(message._id);
              } catch {
                setNotice(t("messages:updateError"));
              }
            },
          },
        );
      if (message.locked) {
        const sealed = message.locked;
        const date = (time: number) =>
          formatDateTime(time, resolveLanguage(locale), undefined, true);
        actions.push({
          key: "unlock-details",
          label: t("messages:lockedDetails"),
          onPress: () =>
            Alert.alert(
              t("messages:lockedDetails"),
              [
                t("messages:openSelectedTime", {
                  time: date(sealed.requestedAt),
                }),
                t("messages:openRoundTime", { time: date(sealed.roundTime) }),
              ].join("\n"),
            ),
        });
        if (canRetryUnlock(sealed.error))
          actions.push({
            key: "unlock-retry",
            label: t("messages:lockedRetry"),
            onPress: () => {
              try {
                chat.retryUnlock(peerKey, message._id, Date.now());
              } catch {
                setNotice(t("messages:updateError"));
              }
            },
          });
      }
      if (message.voice && (message.pending || message.isFailed))
        actions.push({
          key: "cancel-voice",
          label: t("messages:voiceCancelSend"),
          onPress: () => messaging.cancelVoice(peerKey, message._id),
        });
      if (!message.isFailed) return actions;
      const uploadFailure = message.failure?.startsWith("media-")
        ? message.failure.slice(6)
        : undefined;
      const detail = isUploadFailure(uploadFailure)
        ? t(`settings:mediaFailure_${uploadFailure}`)
        : message.failure === "media-upload"
          ? t("messages:voiceUploadFailed")
          : message.failure === "no-inbox"
            ? t("messages:noInbox")
            : message.failure === "invalid-message"
              ? t("messages:invalidMessage")
              : t("messages:relayRejected");
      return [
        ...actions,
        {
          key: "send-failure-detail",
          label: t("messages:sendFailureDetail"),
          onPress: () => Alert.alert(t("messages:sendFailureDetail"), detail),
        },
      ];
    },
    [t, chat, locale, peerKey, refresh, messaging],
  );

  const reactions = useMemo<ChatProps<DetailMessage>["reactions"]>(
    () => ({
      isEnabled: true,
      getUser: resolveUser,
      onReactionPress: (message, emoji) => {
        try {
          messaging.toggleReaction({ peerKey, messageId: message._id, emoji });
        } catch {
          setNotice(t("messages:updateError"));
        }
      },
    }),
    [t, messaging, peerKey, resolveUser],
  );

  const reply = useMemo<ChatProps<DetailMessage>["reply"]>(
    () => ({
      swipe: { isEnabled: true, direction: rtl ? "right" : "left" },
      message: quote,
      onReply: (message) =>
        updateQuote({
          _id: message._id,
          user: message.user,
          text: message.voice
            ? t("messages:voiceMessage")
            : message.locked
              ? t("messages:lockedMessage")
              : (message.originalText ?? message.text),
        }),
      onClear: () => updateQuote(null),
      onPress: jumpToQuote,
    }),
    [jumpToQuote, quote, rtl, t, updateQuote],
  );

  const messageTextProps = useMemo<
    ChatProps<DetailMessage>["messageTextProps"]
  >(
    () => ({
      url: true,
      phone: false,
      email: false,
      hashtag: false,
      mention: false,
      markdown: false,
      customTextStyle: autoText,
      onPress: (_message, value) => {
        try {
          const url = new URL(value);
          if (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.hostname &&
            !url.username &&
            !url.password
          ) {
            void Linking.openURL(url.href).catch(() =>
              setNotice(t("messages:openError")),
            );
          }
        } catch {
          setNotice(t("messages:openError"));
        }
      },
    }),
    [t],
  );

  const textInputProps = useMemo(
    () => ({
      editable: !sending,
      maxLength: 4000,
      style: autoText,
    }),
    [sending],
  );

  const openContact = useCallback(
    () => router.push({ pathname: "/contact/[key]", params: { key: peerKey } }),
    [peerKey],
  );
  const back = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/messages");
  }, []);
  const headerActions = useCallback(
    () => (
      <View style={styles.headerActions}>
        {stressEnabled ? (
          <IconButton
            icon="add"
            label={t("messages:testMessage")}
            disabled={scheduled}
            onPress={schedule}
          />
        ) : null}
        <IconButton
          icon="phone"
          label={t("messages:call")}
          disabled={blocked}
          onPress={() =>
            router.push({ pathname: "/call/[key]", params: { key: peerKey } })
          }
        />
      </View>
    ),
    [t, peerKey, schedule, scheduled, stressEnabled, blocked],
  );

  return (
    <ScreenInsets
      edges={["top", "left", "right"]}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <LinearGradient
        pointerEvents="none"
        colors={material.canvas}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {!reducedTransparency && (
        <Image
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
        <ChatHeader
          {...kit}
          title={name}
          subtitle={t(`messages:${status}`)}
          isSubtitleActive={status === "online"}
          avatar={{ id: peerKey, uri: avatar }}
          onBack={back}
          onPressTitle={openContact}
          renderRight={headerActions}
          isTopInsetApplied={false}
          style={styles.headerContent}
        />
      </GlassSurface>
      {(error || notice) && (
        <View style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Ink
            kind="caption"
            accessibilityLiveRegion="polite"
            style={styles.noticeText}
          >
            {error ? t("messages:historyError") : notice}
          </Ink>
          {error ? (
            <Action size="sm" variant="ghost" onPress={retry}>
              {t("messages:retry")}
            </Action>
          ) : null}
        </View>
      )}
      {newer ? (
        <View style={styles.latest}>
          <Action size="sm" variant="soft" onPress={goLatest}>
            {t("messages:latest")}
          </Action>
        </View>
      ) : null}
      {missing.length > 0 ? (
        <View style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Ink kind="caption" style={styles.noticeText}>
            {t("translation:downloadRequired")}
          </Ink>
          <Action
            size="sm"
            variant="ghost"
            onPress={() =>
              router.push({
                pathname: "/settings/chats/models",
                params: { needed: missing.join(",") },
              })
            }
          >
            {t("translation:manageModels")}
          </Action>
        </View>
      ) : failed ? (
        <View style={[styles.notice, { backgroundColor: colors.surface }]}>
          <Ink kind="caption" style={styles.noticeText}>
            {t("translation:loadFailed")}
          </Ink>
          <Action size="sm" variant="ghost" onPress={retryTranslation}>
            {t("common:retry")}
          </Action>
        </View>
      ) : null}
      <View style={styles.chat} ref={menuHost} collapsable={false}>
        <Chat<DetailMessage>
          {...kit}
          chatRef={chatRef}
          textInputRef={textInputRef}
          messages={displayed}
          user={participants.self}
          forceRTL={rtl}
          enableKeyboardProvider={false}
          enableGestureHandlerRootView={false}
          isInverted={false}
          isGroupChat={false}
          isAlignedTop
          isDayAnimationEnabled={!reducedMotion}
          isScrollToBottomEnabled={!detached || !newer}
          firstUnreadMessageId={firstUnreadMessageId}
          loadEarlierMessagesProps={loadEarlierMessagesProps}
          listProps={listProps}
          initialText={initialDraft.text}
          text={draft}
          onDraftChange={updateText}
          textInputProps={textInputProps}
          renderInputToolbar={
            blocked
              ? () => (
                  <Action onPress={blockAction.onPress}>
                    {t("security:blockedChat")}
                  </Action>
                )
              : renderToolbar
          }
          renderComposer={renderComposer}
          renderSend={emptySendSlot}
          isMultiline
          emptyChatGreeting={null}
          defaultMessageActions={messageActions}
          messageActions={actionsForMessage}
          onDeleteMessage={deleteOne}
          onDeleteMessages={confirmDelete}
          onRetryMessage={retryMessage}
          reactions={reactions}
          reply={reply}
          messageTextProps={messageTextProps}
          renderBubble={renderTranslatedBubble}
          attachments={false}
          audioRecording={audioRecording}
          onSend={onSendVoice}
          mediaPlayback={mediaPlayback}
          videoRecording={false}
          emojiKeyboard
        />
        {menu ? (
          <SpecialSendMenu
            anchor={menu}
            rtl={rtl}
            reducedMotion={reducedMotion}
            onClose={closeMenu}
            onOpenLater={showOpenLater}
          />
        ) : null}
      </View>
      {pickerSession > 0 ? (
        <OpenLaterSheet
          key={pickerSession}
          open={openLater}
          busy={sending}
          error={openError}
          colorScheme={colorScheme}
          rtl={rtl}
          onCancel={cancelOpenLater}
          onSend={(time) => {
            setOpenError(undefined);
            void sendText(
              composition.current.text,
              () => clearSpecialInput.current?.(),
              time,
            );
          }}
        />
      ) : null}
    </ScreenInsets>
  );
}

const styles = StyleSheet.create({
  translationMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  translationMetaRtl: { flexDirection: "row-reverse" },
  translationLink: {
    fontSize: 11,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  screen: { flex: 1 },
  // Chat Kit mirrors bubble rows itself. Keep their base flex axis physical.
  chat: { flex: 1, direction: "ltr" },
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
  headerActions: { flexDirection: "row", gap: space.xs },
  // Chat Kit keeps a 6 pt gap beside its empty Send slot. Absorb it into the gutter.
  toolbar: { direction: "ltr", paddingStart: space.sm, paddingEnd: 2 },
  rtlToolbar: { direction: "ltr", paddingStart: 2, paddingEnd: space.sm },
  rtlReplyPreview: { direction: "rtl" },
  composerControls: {
    flex: 1,
    minWidth: 0,
    direction: "ltr",
    flexDirection: "row",
    alignItems: "flex-end",
  },
  rtlControls: { flexDirection: "row-reverse" },
  send: { alignItems: "flex-end", marginEnd: -6 },
  rtlSend: { alignItems: "flex-start", marginStart: -6 },
  sendGlyph: {
    width: 34,
    height: 34,
    borderRadius: radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
    flexDirection: "row",
    alignItems: "center",
  },
  noticeText: { flex: 1 },
  latest: {
    alignSelf: "center",
    zIndex: 1,
    marginTop: space.sm,
    borderRadius: radius.round,
  },
});
