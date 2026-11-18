import {
  Chat,
  type ChatHandle,
  ChatHeader,
  type ChatIcons,
  type ChatProps,
  Composer,
  InputToolbar,
  type MessageActionKey,
  type MessageMenuItem,
  type ReplyMessage,
  Send,
  type SendProps,
} from "@kesha-antonov/react-native-chat";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  Alert,
  AppState,
  Image,
  Linking,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Action, Icon, IconButton, Ink } from "@/components/ui/kit";
import { nameOrAddress, useContact } from "@/db/contacts";
import type { MessageCursor } from "@/db/messaging";
import { useLocal } from "@/services/local";
import { radius, space } from "@/theme";
import { conversationMaterials, useChatAppearance } from "./appearance";
import { type DetailMessage, toQuote } from "./detail-adapter";
import { useDetailHistory } from "./detail-history";

const translations = {
  en: {
    self: "You",
    call: "Call",
    online: "Relays connected",
    connecting: "Connecting to relays…",
    offline: "Offline · messages will queue",
    disabled: "No relays enabled",
    unavailableQuote: "Original message unavailable",
    latest: "Jump to latest",
    deleteLocal: "Delete on this device",
    deletePrompt:
      "This removes the selection from Boop on this device. Copies on relays and other devices can still exist.",
    historyError: "Chat history could not be loaded.",
    updateError: "The change could not be saved. Try again.",
    sendError: "The message could not be queued. Your draft is still here.",
    sendReplyError:
      "The original message is unavailable. Remove the quote to send this message.",
    sendFailureDetail: "Why it failed",
    noInbox:
      "Boop could not find an inbox relay for this contact. Try again after they configure an inbox relay.",
    relayRejected:
      "A relay did not accept the message. Check your relay connection and try again.",
    invalidMessage:
      "The queued message could not be read. Copy its text and compose a new message.",
    openError: "This link could not be opened.",
    retry: "Try again",
    cancel: "Cancel",
    send: "Send message",
  },
  he: {
    self: "אני",
    call: "שיחה",
    online: "שרתים מחוברים",
    connecting: "מתחבר לשרתים…",
    offline: "אין חיבור · ההודעות יישלחו בהמשך",
    disabled: "אין שרתים פעילים",
    unavailableQuote: "ההודעה המקורית אינה זמינה",
    latest: "מעבר להודעות האחרונות",
    deleteLocal: "מחיקה במכשיר הזה",
    deletePrompt:
      "ההודעות שסומנו יימחקו מ־Boop במכשיר הזה. עותקים עשויים להישאר בשרתים ובמכשירים אחרים.",
    historyError: "לא ניתן לטעון את היסטוריית השיחה.",
    updateError: "לא ניתן לשמור את השינוי. אפשר לנסות שוב.",
    sendError: "לא ניתן להוסיף את ההודעה לתור. הטיוטה נשמרה.",
    sendReplyError:
      "ההודעה המקורית אינה זמינה. אפשר להסיר את הציטוט כדי לשלוח את ההודעה.",
    sendFailureDetail: "למה השליחה נכשלה",
    noInbox: "לא נמצא שרת קבלה לאיש הקשר. אפשר לנסות שוב לאחר הגדרת שרת קבלה.",
    relayRejected:
      "שרת השליחה לא קיבל את ההודעה. כדאי לבדוק את החיבור ולנסות שוב.",
    invalidMessage:
      "לא ניתן לקרוא את ההודעה שבתור. אפשר להעתיק את הטקסט ולכתוב הודעה חדשה.",
    openError: "לא ניתן לפתוח את הקישור.",
    retry: "ניסיון נוסף",
    cancel: "ביטול",
    send: "שליחת הודעה",
  },
};

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
const icons: ChatIcons = { send: (props) => <Icon name="send" {...props} /> };
const autoText = { textAlign: "auto", writingDirection: "auto" } as const;
const emptySendSlot = () => null;

function useStressArrival(peerKey: string) {
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
        Alert.alert("Unable to add the test message");
      }
    }, 4_000);
  }, [chat, factory, identity.publicKey]);
  return { available: Boolean(factory), schedule, scheduled };
}

export function DetailConversation({ peerKey }: { peerKey: string }) {
  const { chat, identity, messaging } = useLocal();
  const {
    available: stressEnabled,
    scheduled,
    schedule,
  } = useStressArrival(peerKey);
  const contact = useContact(peerKey);
  const name = nameOrAddress(contact?.name, peerKey);
  const focused = useIsFocused();
  const {
    theme,
    darkTheme,
    appearance,
    colorScheme,
    locale,
    labels,
    rtl,
    colors,
    reducedMotion,
    reducedTransparency,
  } = useChatAppearance(true);
  const material = conversationMaterials[colorScheme];
  const copy = /^he(?:-|$)/i.test(locale) ? translations.he : translations.en;
  const kit = useMemo(
    () => ({
      theme,
      darkTheme,
      appearance,
      colorScheme,
      locale,
      labels: { ...labels, actionDelete: copy.deleteLocal, send: copy.send },
      icons,
    }),
    [theme, darkTheme, appearance, colorScheme, locale, labels, copy],
  );
  const participants = useMemo(
    () => ({
      self: { _id: identity.publicKey, name: copy.self },
      peer: { _id: peerKey, name, avatar: contact?.avatarUrl ?? undefined },
    }),
    [identity.publicKey, peerKey, name, copy.self, contact?.avatarUrl],
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
    initiallyDetached,
  } = useDetailHistory(chat, peerKey, participants, copy.unavailableQuote);
  const [detached, setDetached] = useState(initiallyDetached);
  const [atLatest, setAtLatest] = useState(firstUnreadMessageId === null);
  const latestPosition = useRef(firstUnreadMessageId === null);
  const [loadingPage, startPage] = useTransition();
  const [jump, setJump] = useState<{ id: string; highlight: boolean }>();
  const [notice, setNotice] = useState<string>();
  const chatRef = useRef<ChatHandle>(null);

  const [initialDraft] = useState(() => {
    try {
      const saved = chat.conversation(peerKey);
      const target = saved?.draftReplyTo
        ? chat.message(peerKey, saved.draftReplyTo)
        : undefined;
      const quote = target ? toQuote(target, participants) : null;
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
      if (text || reply || chat.conversation(peerKey)) {
        chat.saveDraft(peerKey, text, reply);
      }
      pendingDraft.current = null;
    } catch {
      setNotice(copy.updateError);
    }
  }, [chat, peerKey, copy.updateError]);

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
    async (text: string, clearInput: () => void) => {
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
        setNotice(
          error instanceof Error && error.message === "unavailable-reply"
            ? copy.sendReplyError
            : copy.sendError,
        );
        return;
      } finally {
        sendBusy.current = false;
        setSending(false);
      }
      try {
        const id = loadLatest();
        if (id) setJump({ id, highlight: false });
      } catch {
        setNotice(copy.historyError);
      }
    },
    [messaging, peerKey, flushDraft, loadLatest, copy],
  );

  // Keep the built-in button, and clear the controlled composer only after SQLite commits.
  const renderSend = useCallback(
    (props: SendProps<DetailMessage>) => {
      const enabled = !sending && Boolean(props.text?.trim());
      return (
        <Send
          {...props}
          isSendButtonAlwaysVisible
          sendButtonProps={{
            ...props.sendButtonProps,
            accessibilityLabel: copy.send,
            accessibilityState: { disabled: !enabled, busy: sending },
            enabled,
          }}
          onSend={(value) => {
            const message = Array.isArray(value) ? value[0] : value;
            if (message?.text) {
              void sendText(message.text, () => props.onSend?.([], true));
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
      );
    },
    [colors, copy.send, material.outgoing, sendText, sending],
  );

  const renderComposer = useCallback(
    (props: ComponentProps<typeof Composer>) => (
      <View style={[styles.composerControls, rtl && styles.rtlControls]}>
        <Composer {...props} />
        {renderSend({ text: props.text, onSend: props.onSend })}
      </View>
    ),
    [renderSend, rtl],
  );

  const renderToolbar = useCallback(
    (props: ComponentProps<typeof InputToolbar<DetailMessage>>) => (
      <InputToolbar
        {...props}
        containerStyle={rtl ? styles.rtlToolbar : styles.toolbar}
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
          setNotice(copy.unavailableQuote);
          return;
        }
        loadAround(row);
        setDetached(true);
        setJump({ id: row.id, highlight: true });
      } catch {
        setNotice(copy.historyError);
      }
    },
    [chat, copy, items, loadAround, peerKey, reducedMotion],
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
      setNotice(copy.historyError);
    }
  }, [copy.historyError, loadLatest]);

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
            setNotice(copy.historyError);
          }
        });
      },
    }),
    [copy.historyError, loadingPage, older, olderPage],
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
  const onViewableItemsChanged = useCallback<
    NonNullable<ListProps["onViewableItemsChanged"]>
  >(
    ({ viewableItems }) => {
      if (!focused || AppState.currentState !== "active") return;
      let newest: MessageCursor | undefined;
      for (const { item, isViewable } of viewableItems) {
        if (!isViewable || !item.unread) continue;
        const cursor = { id: item._id, sentAt: item.createdAt };
        if (
          !newest ||
          cursor.sentAt > newest.sentAt ||
          (cursor.sentAt === newest.sentAt && cursor.id > newest.id)
        ) {
          newest = cursor;
        }
      }
      if (newest) {
        try {
          chat.markRead(peerKey, newest);
        } catch {
          setNotice(copy.updateError);
        }
      }
    },
    [chat, copy.updateError, focused, peerKey],
  );

  const listProps = useMemo<ListProps>(
    () => ({
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
    ],
  );

  const confirmDelete = useCallback(
    (messages: DetailMessage[]) => {
      Alert.alert(copy.deleteLocal, copy.deletePrompt, [
        { text: copy.cancel, style: "cancel" },
        {
          text: copy.deleteLocal,
          style: "destructive",
          onPress: () => {
            try {
              chat.deleteMessages(
                peerKey,
                messages.map((message) => message._id),
              );
            } catch {
              setNotice(copy.updateError);
            }
          },
        },
      ]);
    },
    [chat, copy, peerKey],
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
        setNotice(copy.updateError);
      }
    },
    [copy.updateError, messaging, peerKey],
  );

  const actionsForMessage = useCallback(
    (message: DetailMessage, defaults: MessageMenuItem[]) => {
      if (!message.isFailed) return defaults;
      const detail =
        message.failure === "no-inbox"
          ? copy.noInbox
          : message.failure === "invalid-message"
            ? copy.invalidMessage
            : copy.relayRejected;
      return [
        ...defaults,
        {
          key: "send-failure-detail",
          label: copy.sendFailureDetail,
          onPress: () => Alert.alert(copy.sendFailureDetail, detail),
        },
      ];
    },
    [copy],
  );

  const reactions = useMemo<ChatProps<DetailMessage>["reactions"]>(
    () => ({
      isEnabled: true,
      getUser: resolveUser,
      onReactionPress: (message, emoji) => {
        try {
          messaging.toggleReaction({ peerKey, messageId: message._id, emoji });
        } catch {
          setNotice(copy.updateError);
        }
      },
    }),
    [copy.updateError, messaging, peerKey, resolveUser],
  );

  const reply = useMemo<ChatProps<DetailMessage>["reply"]>(
    () => ({
      swipe: { isEnabled: true, direction: rtl ? "right" : "left" },
      message: quote,
      onReply: (message) =>
        updateQuote({
          _id: message._id,
          user: message.user,
          text: message.text,
        }),
      onClear: () => updateQuote(null),
      onPress: jumpToQuote,
    }),
    [jumpToQuote, quote, rtl, updateQuote],
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
              setNotice(copy.openError),
            );
          }
        } catch {
          setNotice(copy.openError);
        }
      },
    }),
    [copy.openError],
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
            label="Simulate a test message"
            disabled={scheduled}
            onPress={schedule}
          />
        ) : null}
        <IconButton
          icon="phone"
          label={copy.call}
          onPress={() =>
            router.push({ pathname: "/call/[key]", params: { key: peerKey } })
          }
        />
      </View>
    ),
    [copy.call, peerKey, schedule, scheduled, stressEnabled],
  );

  return (
    <SafeAreaView
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
          subtitle={copy[status]}
          isSubtitleActive={status === "online"}
          avatar={{ id: peerKey, uri: contact?.avatarUrl ?? undefined }}
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
            {error ? copy.historyError : notice}
          </Ink>
          {error ? (
            <Action size="sm" variant="ghost" onPress={retry}>
              {copy.retry}
            </Action>
          ) : null}
        </View>
      )}
      {detached && newer ? (
        <View style={styles.latest}>
          <Action size="sm" variant="soft" onPress={goLatest}>
            {copy.latest}
          </Action>
        </View>
      ) : null}
      <Chat<DetailMessage>
        {...kit}
        chatRef={chatRef}
        messages={items}
        user={participants.self}
        forceRTL={rtl}
        enableGestureHandlerRootView={false}
        isInverted={false}
        isGroupChat={false}
        isAlignedTop="auto"
        isDayAnimationEnabled={!reducedMotion}
        isScrollToBottomEnabled={!detached || !newer}
        firstUnreadMessageId={firstUnreadMessageId}
        loadEarlierMessagesProps={loadEarlierMessagesProps}
        listProps={listProps}
        initialText={initialDraft.text}
        text={draft}
        onDraftChange={updateText}
        textInputProps={textInputProps}
        renderInputToolbar={renderToolbar}
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
        attachments={false}
        audioRecording={false}
        videoRecording={false}
        emojiKeyboard
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  headerActions: { flexDirection: "row", gap: space.xs },
  // Chat Kit keeps a 6 pt gap beside its empty Send slot. Absorb it into the gutter.
  toolbar: { direction: "ltr", paddingStart: space.sm, paddingEnd: 2 },
  rtlToolbar: { direction: "ltr", paddingStart: 2, paddingEnd: space.sm },
  composerControls: {
    flex: 1,
    minWidth: 0,
    direction: "ltr",
    flexDirection: "row",
    alignItems: "flex-end",
  },
  rtlControls: { flexDirection: "row-reverse" },
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
