import { useTranslation } from "react-i18next";
import { LoadingStatus } from "@/components/ui/loading-status";
import { Action, Ink } from "@/components/ui/kit";
import type { OpenLaterState } from "@/core/messaging/special-messages/open-conversation";
import { namespaces } from "@/i18n";
import { useTheme } from "@/theme";
import { canRetryUnlock, LockedMessageBubble } from "./timelock-message";

export function MarmotLocked({
  state,
  retry,
  rtl,
}: {
  state: OpenLaterState | undefined;
  retry: () => void;
  rtl: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();

  if (!state) return null;
  if (state.kind === "opened") return <Ink>{state.text}</Ink>;
  if (state.kind === "invalid") return <Ink>{t("messages:lockedInvalid")}</Ink>;
  const error = state.kind === "failed" ? state.error : null;
  return (
    <>
      <LockedMessageBubble
        lock={{ requestedAt: state.requestedAt, error }}
        color={colors.text}
        rtl={rtl}
      />
      {state.kind === "opening" && (
        <LoadingStatus label={t("messages:lockedOpening")} />
      )}
      {(canRetryUnlock(error) || state.kind === "locked") && (
        <Action size="sm" onPress={retry}>
          {t("common:retry")}
        </Action>
      )}
    </>
  );
}
