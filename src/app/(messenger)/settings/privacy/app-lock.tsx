import { ScreenHeader } from "@/components/navigation/screen-header";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsDescription,
  ListGroup,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { Screen } from "@/components/ui/kit";
import { lockTimeouts } from "@/core/security/app-lock";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

const labels = {
  0: "security:immediately",
  60000: "security:afterMinute",
  300000: "security:afterFive",
  1800000: "security:afterThirty",
} as const;

export default function AppLockSettings() {
  const { t } = useTranslation(namespaces);
  const { lock } = useLocal();
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  const [error, setError] = useState("");

  return (
    <Screen navigationHeader={<ScreenHeader title={t("security:appLock")} />}>
      <ListGroup>
        <PreferenceToggle
          title={t("security:appLock")}
          detail={
            state.authenticating ? t("security:authenticating") : undefined
          }
          value={state.enabled}
          disabled={state.authenticating}
          onChange={(value) => {
            setError("");
            void lock.change(value ? "enable" : "disable");
          }}
        />
        {state.enabled && (
          <SettingsMenuRow
            title={t("security:lockAfter")}
            value={state.timeout}
            options={lockTimeouts.map((value) => ({
              value,
              label: t(labels[value]),
            }))}
            disabled={state.authenticating}
            onChange={(value) => {
              try {
                lock.setTimeout(value);
                setError("");
              } catch {
                setError(t("security:saveTimeoutError"));
              }
            }}
          />
        )}
      </ListGroup>
      {error || state.error ? (
        <SettingsDescription>
          {error || (state.error ? t(`security:${state.error}`) : null)}
        </SettingsDescription>
      ) : (
        !state.enabled && (
          <SettingsDescription>{t("security:lockHint")}</SettingsDescription>
        )
      )}
    </Screen>
  );
}
