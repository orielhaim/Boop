import { useTheme } from "@kesha-antonov/react-native-chat";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { LoadingStatus } from "@/components/ui/loading-status";
import { Action } from "@/components/ui/kit";
import type { OpenLaterState } from "@/core/messaging/special-messages/open-conversation";
import { namespaces } from "@/i18n";
import { canRetryUnlock, LockedMessageBubble } from "./timelock-message";

export function MarmotLocked({
  state,
  retry,
  rtl,
  outgoing,
}: {
  state: OpenLaterState | undefined;
  retry?: () => void;
  rtl: boolean;
  outgoing: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { colors, spacing, typography } = useTheme();
  const color = outgoing ? colors.outgoingText : colors.incomingText;

  if (!state) return null;
  if (state.kind === "opened" || state.kind === "invalid")
    return (
      <Text
        style={[
          typography.message,
          {
            color,
            marginHorizontal: spacing.bubblePaddingH,
            marginTop: spacing.bubblePaddingV,
            marginBottom: spacing.bubblePaddingBottom,
          },
        ]}
      >
        {state.kind === "opened" ? state.text : t("messages:lockedInvalid")}
      </Text>
    );
  const error = state.kind === "failed" ? state.error : null;
  return (
    <>
      <LockedMessageBubble
        lock={{ requestedAt: state.requestedAt, error }}
        color={color}
        rtl={rtl}
      />
      {state.kind === "opening" && (
        <LoadingStatus label={t("messages:lockedOpening")} color={color} />
      )}
      {retry && canRetryUnlock(error) && (
        <Action size="sm" onPress={retry}>
          {t("common:retry")}
        </Action>
      )}
    </>
  );
}
