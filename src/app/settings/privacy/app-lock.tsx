import { useState, useSyncExternalStore } from "react";
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
import { useLocal } from "@/services/local";

const labels = {
  0: "Immediately",
  60000: "After 1 minute",
  300000: "After 5 minutes",
  1800000: "After 30 minutes",
};

export default function AppLockSettings() {
  const { lock } = useLocal();
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  const [selectTimeout, setSelectTimeout] = useState(false);
  const [error, setError] = useState("");

  return (
    <Screen>
      <SettingsGroup>
        <SettingsToggle
          title="App Lock"
          detail={state.authenticating ? "Authenticating…" : undefined}
          value={state.enabled}
          disabled={state.authenticating}
          onChange={(value) => {
            setError("");
            void lock.change(value ? "enable" : "disable");
          }}
        />
        {state.enabled && (
          <SettingsRow
            title="Lock after leaving Boop"
            value={labels[state.timeout]}
            onPress={() => setSelectTimeout(true)}
          />
        )}
      </SettingsGroup>
      {error || state.error ? (
        <SettingsDescription>{error || state.error}</SettingsDescription>
      ) : (
        !state.enabled && (
          <SettingsDescription>
            Require device authentication when you open Boop.
          </SettingsDescription>
        )
      )}
      <GlassSheet
        open={selectTimeout && state.enabled}
        onOpenChange={setSelectTimeout}
      >
        <GlassSheetContent>
          <GlassSheetTitle>Lock after leaving Boop</GlassSheetTitle>
          <SettingsGroup>
            {lockTimeouts.map((timeout) => (
              <SettingsRow
                key={timeout}
                title={labels[timeout]}
                selected={state.timeout === timeout}
                onPress={() => {
                  try {
                    lock.setTimeout(timeout);
                    setError("");
                  } catch {
                    setError("Could not save the lock timeout.");
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
