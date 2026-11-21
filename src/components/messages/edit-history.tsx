import {
  Bubble,
  ChatContext,
  resolveTheme,
  useChatContext,
} from "@kesha-antonov/react-native-chat";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, StyleSheet, useWindowDimensions, View } from "react-native";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { Ink } from "@/components/ui/kit";
import type { MessagingRepository } from "@/db/messaging";
import { namespaces } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { useLocal } from "@/services/local";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import type { Participants } from "./detail-adapter";

function historySnapshot(chat: MessagingRepository, peer: string, id: string) {
  let cachedRevision: number | undefined;
  let history: ReturnType<MessagingRepository["revisions"]> = null;
  return () => {
    const revision = chat.historyRevision(peer);
    if (cachedRevision === revision) return history;
    cachedRevision = revision;
    try {
      history = chat.revisions(peer, id);
    } catch {
      history = null;
    }
    return history;
  };
}

export function EditHistory({
  peer,
  id,
  open,
  participants,
  onClose,
}: {
  peer: string;
  id: string;
  open: boolean;
  participants: Participants;
  onClose: () => void;
}) {
  const { chat } = useLocal();
  const { t } = useTranslation(namespaces);
  const kit = useChatAppearance(true);
  const fallback = useChatContext();
  const { height } = useWindowDimensions();
  const subscribe = useCallback(
    (listener: () => void) => (open ? chat.subscribe(listener) : () => {}),
    [chat, open],
  );
  const snapshot = useMemo(
    () => historySnapshot(chat, peer, id),
    [chat, peer, id],
  );
  const history = useSyncExternalStore(subscribe, snapshot);
  const outgoing = history?.direction === "outgoing";
  const author = outgoing ? participants.self : participants.peer;
  const theme = resolveTheme(
    kit.colorScheme,
    kit.theme,
    kit.darkTheme,
    kit.appearance,
  );

  return (
    <GlassSheet
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <GlassSheetContent
        closeLabel={t("common:close")}
        style={{ direction: kit.rtl ? "rtl" : "ltr" }}
      >
        <GlassSheetTitle>{t("messages:editHistory")}</GlassSheetTitle>
        {history ? (
          <ChatContext.Provider
            value={{
              ...fallback,
              getTheme: () => theme,
              getLocale: () => kit.locale,
              getIsRTL: () => kit.rtl,
              getColorScheme: () => kit.colorScheme,
            }}
          >
            <Ink kind="caption" style={styles.author}>
              {author.name}
            </Ink>
            {history.incomplete ? (
              <Ink kind="caption">{t("messages:editHistoryIncomplete")}</Ink>
            ) : null}
            <FlatList
              style={{ maxHeight: height * 0.57 }}
              contentContainerStyle={styles.timeline}
              data={history.versions}
              keyExtractor={(item) => item.revisionId}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const current = item.revisionId === history.current;
                return (
                  <View
                    style={[
                      styles.entry,
                      current && { borderColor: kit.colors.accent },
                    ]}
                  >
                    <Ink
                      kind="caption"
                      style={
                        current
                          ? { color: kit.colors.accent, fontWeight: "700" }
                          : undefined
                      }
                    >
                      {t("messages:editVersion", {
                        label: t(
                          current
                            ? "messages:editLatest"
                            : item.depth === 0
                              ? "messages:editOriginal"
                              : "messages:edited",
                        ),
                        time: formatDateTime(item.timestamp, kit.locale),
                      })}
                    </Ink>
                    <Bubble
                      position={outgoing ? "right" : "left"}
                      currentMessage={{
                        _id: item.revisionId,
                        text: item.body,
                        user: author,
                        createdAt: item.timestamp,
                      }}
                      isMessageGestureEnabled={false}
                      renderLinkPreview={null}
                      renderTime={() => null}
                      messageTextProps={{
                        url: false,
                        phone: false,
                        email: false,
                        hashtag: false,
                        mention: false,
                        markdown: false,
                        customTextStyle: {
                          writingDirection: "auto",
                          textAlign: "auto",
                        },
                      }}
                    />
                  </View>
                );
              }}
            />
          </ChatContext.Provider>
        ) : (
          <Ink kind="caption">{t("messages:editHistoryUnavailable")}</Ink>
        )}
      </GlassSheetContent>
    </GlassSheet>
  );
}

const styles = StyleSheet.create({
  author: { marginBottom: space.xs },
  timeline: { paddingVertical: space.sm, gap: space.md },
  entry: {
    paddingStart: space.sm,
    borderStartWidth: 2,
    borderColor: "transparent",
    gap: space.xs,
  },
});
