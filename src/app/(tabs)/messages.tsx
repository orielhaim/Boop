import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { ProfileChatCell } from "@/components/messages/profile-chat-cell";
import { ChatList } from "@kesha-antonov/react-native-chat";
import { Redirect, router } from "expo-router";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useChatAppearance } from "@/components/messages/appearance";
import {
  type ConversationListItem,
  createConversationListAdapter,
  matchesConversation,
} from "@/components/messages/conversation-item";
import { Action, Empty, Icon, Ink, Screen } from "@/components/ui/kit";
import { PeerActions } from "@/components/ui/peer-actions";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime, formatDuration } from "@/i18n/format";
import { useChatsEnabled, useLocal } from "@/services/local";
import { space, useTheme } from "@/theme";

function keys(items: ConversationListItem[]) {
  return items.map((item) => item.id);
}

export default function Messages() {
  const enabled = useChatsEnabled();
  return enabled ? <MessageInbox /> : <Redirect href="/" />;
}

function MessageInbox() {
  const { t } = useTranslation(namespaces);
  const { identity, chat, conversations, messaging } = useLocal();
  const privacy = usePrivacy();
  const visibleAvatars = useAvatarVisibility<ConversationListItem>(
    (item) => item.id,
  );
  const pending = privacy.pendingCount();
  const { colors } = useTheme();
  const { appearance, theme, darkTheme, colorScheme, labels, locale, icons } =
    useChatAppearance();
  const [archived, setArchived] = useState(false);
  const [searching, setSearching] = useState(false);
  const [actions, setActions] = useState(false);

  const result = useSyncExternalStore(
    conversations.subscribe,
    conversations.getSnapshot,
    conversations.getSnapshot,
  );
  const rows = result?.rows;
  const status = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getStatus,
    messaging.getStatus,
  );
  const sync = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getInboxSync,
    messaging.getInboxSync,
  );
  const adapt = useMemo(
    () =>
      createConversationListAdapter(
        identity.publicKey,
        (text) => t("translation:preview", { text }),
        (time) =>
          t("messages:lockedPreview", {
            time: formatDateTime(time, resolveLanguage(locale)),
          }),
        (duration) =>
          duration == null
            ? t("messages:voiceMessage")
            : t("messages:voicePreview", {
                duration: formatDuration(duration / 1000),
              }),
      ),
    [identity.publicKey, locale, t],
  );
  const chats = useMemo(() => (rows ?? []).map(adapt), [rows, adapt]);
  const emptyStatus =
    sync === "syncing"
      ? t("messages:syncing")
      : sync === "failed"
        ? t("messages:syncFailed")
        : status === "online"
          ? undefined
          : t(`messages:${status}`);
  function change(write: () => void) {
    try {
      write();
    } catch {
      Alert.alert(t("messages:updateConversationsError"));
    }
  }

  return (
    <Screen tab scroll={false}>
      <PeerActions mode="chat" open={actions} onOpenChange={setActions} />
      {result?.error && chats.length === 0 ? (
        <Empty
          icon="chat"
          title={t("messages:openConversationsError")}
          detail={t("messages:readLocalError")}
        >
          <Action onPress={conversations.refresh}>{t("common:retry")}</Action>
        </Empty>
      ) : (
        <ChatList
          chats={chats}
          renderChat={(props) => <ProfileChatCell {...props} />}
          user={{ _id: identity.publicKey }}
          isLoading={result === undefined}
          appearance={appearance}
          theme={theme}
          darkTheme={darkTheme}
          colorScheme={colorScheme}
          locale={locale}
          dateFormat={locale === "he" ? "D.M.YY" : undefined}
          labels={labels}
          icons={icons}
          isTopInsetApplied={false}
          isSortEnabled={false}
          isArchiveOpen={archived}
          onArchiveOpenChange={setArchived}
          filterChat={matchesConversation}
          onSearchChange={(query) => setSearching(query !== null)}
          renderEmpty={(searching) => (
            <View style={styles.empty}>
              <Empty
                icon="chat"
                title={
                  searching
                    ? labels.chatListNoResults
                    : archived
                      ? t("messages:noArchived")
                      : sync === "syncing" || status === "connecting"
                        ? (emptyStatus ?? labels.chatListEmpty)
                        : labels.chatListEmpty
                }
                detail={
                  searching ||
                  archived ||
                  sync === "syncing" ||
                  status === "connecting"
                    ? ""
                    : (emptyStatus ?? t("messages:startHint"))
                }
              />
            </View>
          )}
          onPressChat={(item) =>
            router.push({ pathname: "/chat/[key]", params: { key: item.id } })
          }
          onPressNewChat={() => setActions(true)}
          onPinChats={(selection, pinned) =>
            change(() => chat.updateConversations(keys(selection), { pinned }))
          }
          onMuteChats={(selection, muted) =>
            change(() => chat.updateConversations(keys(selection), { muted }))
          }
          onArchiveChats={(selection, value) =>
            change(() =>
              chat.updateConversations(keys(selection), { archived: value }),
            )
          }
          onDeleteChats={(selection) =>
            change(() => chat.deleteConversations(keys(selection)))
          }
          onReorderPinnedChats={(ids) => change(() => chat.reorderPinned(ids))}
          listProps={{
            ...visibleAvatars,
            ListHeaderComponent:
              pending > 0 && !archived && !searching ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("security:requestsCount", {
                    count: pending,
                  })}
                  onPress={() => router.push("/requests")}
                  style={({ pressed }) => [
                    styles.requests,
                    {
                      backgroundColor: pressed
                        ? colors.accentSoft
                        : colors.surface,
                      borderBottomColor: colors.line,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.requestsIcon,
                      { backgroundColor: colors.accentSoft },
                    ]}
                  >
                    <Icon name="chat" size={22} color={colors.accent} />
                  </View>
                  <Ink kind="label" style={styles.requestsTitle}>
                    {t("security:pendingRequests")}
                  </Ink>
                  <Ink kind="caption" muted>
                    {new Intl.NumberFormat(locale).format(pending)}
                  </Ink>
                  <Icon name="next" size={17} color={colors.muted} />
                </Pressable>
              ) : undefined,
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  requests: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  requestsIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  requestsTitle: { flex: 1 },
  empty: { padding: space.xl },
});
