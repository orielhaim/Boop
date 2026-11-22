import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/ui/kit";
import type { UnlockFailure } from "@/core/messaging/special-messages/timelock";
import { resolveLanguage } from "@/i18n";
import { formatDateTime } from "@/i18n/format";

const statusLabels = {
  "not-ready": "lockedNotReady",
  network: "lockedNetwork",
  endpoint: "lockedEndpoint",
  verification: "lockedVerification",
  ciphertext: "lockedInvalid",
  decryption: "lockedInvalid",
  plaintext: "lockedInvalid",
} as const satisfies Record<UnlockFailure, string>;

export function canRetryUnlock(error: UnlockFailure | null) {
  return error !== null && statusLabels[error] !== "lockedInvalid";
}

export const LockedMessageBubble = memo(function LockedMessageBubble({
  lock,
  color,
  rtl,
}: {
  lock: { requestedAt: number; error: UnlockFailure | null };
  color: string;
  rtl: boolean;
}) {
  const { t, i18n } = useTranslation("messages");
  const when = formatDateTime(
    lock.requestedAt,
    resolveLanguage(i18n.resolvedLanguage),
    undefined,
    true,
  );
  return (
    <View style={[styles.body, rtl && styles.rtl]} accessible>
      <View style={styles.icon}>
        <Icon name="timedLock" size={16} color={color} />
      </View>
      <View style={styles.words}>
        <Text style={[styles.title, { color }]}>{t("lockedMessage")}</Text>
        <Text style={[styles.caption, { color }]}>
          {t("lockedOpens", { time: when })}
        </Text>
        {lock.error ? (
          <Text style={[styles.caption, { color }]}>
            {t(statusLabels[lock.error])}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  body: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 11,
    paddingTop: 8,
    paddingBottom: 4,
  },
  rtl: { flexDirection: "row-reverse" },
  icon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "#88888824",
  },
  words: { flexShrink: 1, gap: 2 },
  title: { fontSize: 14, fontWeight: "700", textAlign: "auto" },
  caption: { fontSize: 12, opacity: 0.88, textAlign: "auto" },
});
