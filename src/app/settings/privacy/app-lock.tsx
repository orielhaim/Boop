import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { lockTimeouts } from "@/core/security/app-lock";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

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
  const [selectTimeout, setSelectTimeout] = useState(false);
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
          <SettingsRow
            title={t("security:lockAfter")}
            value={t(labels[state.timeout])}
            onPress={() => setSelectTimeout(true)}
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
      <GlassSheet
        open={selectTimeout && state.enabled}
        onOpenChange={setSelectTimeout}
      >
        <GlassSheetContent>
          <GlassSheetTitle>{t("security:lockAfter")}</GlassSheetTitle>
          <SettingsGroup>
            {lockTimeouts.map((timeout) => (
              <SettingsRow
                key={timeout}
                title={t(labels[timeout])}
                selected={state.timeout === timeout}
                onPress={() => {
                  try {
                    lock.setTimeout(timeout);
                    setError("");
                  } catch {
                    setError(t("security:saveTimeoutError"));
                  }
                  setSelectTimeout(false);
                }}
              />
            ))}
          </SettingsGroup>
        </GlassSheetContent>
      </GlassSheet>
    </Screen>
  );
}
