import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsToggle,
} from "@/components/settings/group";
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
    <Screen>
      <SettingsGroup>
        <SettingsToggle
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
      </SettingsGroup>
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
