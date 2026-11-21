import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Icon, IconButton, Ink } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import type { MessagingRepository } from "@/db/messaging";
import { space } from "@/theme";
import { toQuote, type Participants } from "./detail-adapter";
import type { MediaLabel } from "./media-label";

function pinnedSnapshot(chat: MessagingRepository, peer: string) {
  let revision: number | undefined;
  let pins: ReturnType<MessagingRepository["pinnedMessages"]> = [];
  return () => {
    const next = chat.historyRevision(peer);
    if (revision !== next) {
      revision = next;
      try {
        pins = chat.pinnedMessages(peer);
      } catch {
        pins = [];
      }
    }
    return pins;
  };
}

export function PinnedBanner({
  peer,
  participants,
  mediaLabel,
  tint,
  rtl,
  onJump,
  onUnpin,
}: {
  peer: string;
  participants: Participants;
  mediaLabel: MediaLabel;
  tint: string;
  rtl: boolean;
  onJump: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const { chat } = useLocal();
  const { t } = useTranslation(namespaces);
  const snapshot = useMemo(() => pinnedSnapshot(chat, peer), [chat, peer]);
  const subscribe = useCallback(
    (listener: () => void) =>
      chat.subscribe(({ history }) => {
        if (history === "all" || history?.includes(peer)) listener();
      }),
    [chat, peer],
  );
  const pins = useSyncExternalStore(subscribe, snapshot);
  const [highlighted, setHighlighted] = useState<string>();
  const index = Math.max(
    0,
    pins.findIndex(({ id }) => id === highlighted),
  );
  const pinned = pins[index];
  if (!pinned) return null;
  const quote = toQuote(
    pinned,
    participants,
    t("messages:lockedMessage"),
    mediaLabel,
  );
  const title = t(
    pins.length > 1 ? "messages:pinnedMessages" : "messages:pinnedMessage",
  );
  return (
    <GlassSurface
      preset="standard"
      tint={tint}
      elevation="none"
      style={styles.surface}
    >
      <View style={[styles.row, { direction: rtl ? "rtl" : "ltr" }]}>
        <Pressable
          style={styles.message}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${quote.text}`}
          onPress={() => onJump(pinned.id)}
        >
          <View style={styles.label}>
            <Icon name="pin" size={13} />
            <Ink kind="caption" muted>
              {pins.length > 1
                ? t("messages:pinnedPosition", {
                    current: index + 1,
                    total: pins.length,
                  })
                : title}
            </Ink>
          </View>
          <Ink kind="caption" numberOfLines={1} style={styles.text}>
            {quote.text}
          </Ink>
        </Pressable>
        {pins.length > 1 && (
          <IconButton
            icon="next"
            label={t("messages:nextPinnedMessage")}
            onPress={() => setHighlighted(pins[(index + 1) % pins.length].id)}
          />
        )}
        <IconButton
          icon="hangup"
          label={t("messages:unpinMessage")}
          onPress={() => onUnpin(pinned.id)}
        />
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  surface: { marginHorizontal: space.sm, marginBottom: space.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.xs,
    paddingVertical: 2,
  },
  message: {
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingStart: space.xs,
  },
  label: { flexDirection: "row", alignItems: "center", gap: space.xs },
  text: { writingDirection: "auto" },
});
