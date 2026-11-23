import { ScreenHeader } from "@/components/navigation/screen-header";
import Constants from "expo-constants";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { BoopLogo } from "@/components/ui/boop-logo";
import { Action, Ink, Screen, Section } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

export default function About() {
  const { t } = useTranslation(namespaces);
  const { calling, relays } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const config = Constants.expoConfig;
  return (
    <Screen navigationHeader={<ScreenHeader title={t("settings:about")} />}>
      <BoopLogo size={56} />
      <SettingsGroup title="Boop">
        <SettingsRow
          title={t("settings:version")}
          value={config?.version ?? t("common:unknown")}
          icon="info"
        />
        <SettingsRow
          title={t("settings:build")}
          value={String(
            config?.ios?.buildNumber ?? config?.android?.versionCode ?? 1,
          )}
          icon="settings"
        />
      </SettingsGroup>

      {__DEV__ ? (
        <>
          <Section>{t("settings:development")}</Section>
          <Action
            disabled={!chatsEnabled}
            onPress={async () => {
              const kit = await import("@kesha-antonov/react-native-chat");
              const capabilities = kit.getChatCapabilities();
              const available = Object.entries(capabilities)
                .flatMap(([name, enabled]) => (enabled ? [name] : []))
                .join(", ");
              setNotice(
                t("settings:chatCapabilitiesResult", {
                  capabilities: available || t("settings:noCapabilities"),
                }),
              );
            }}
          >
            {t("settings:chatCapabilities")}
          </Action>
          <Action
            disabled={checking}
            onPress={async () => {
              setChecking(true);
              try {
                const probe = await import("@/core/calling/native-check");
                const call = calling.store.getState().call;
                const media = await calling.inspect()?.catch(() => undefined);
                const status = [
                  t(`settings:${await probe.checkNativeCalling()}`),
                  t("settings:callDiagnosticState", {
                    phase: call?.phase ?? "idle",
                    transport: relays.getStatus(),
                  }),
                  call?.phase === "connected"
                    ? t("settings:callDiagnosticOutput", {
                        output:
                          call.routing.selected ?? t("settings:systemManaged"),
                      })
                    : "",
                  media
                    ? t("settings:callDiagnosticMedia", {
                        ice: media.ice,
                        microphone: t(
                          media.microphone ? "common:on" : "common:off",
                        ),
                        remote: t(
                          media.remoteTrack
                            ? "settings:present"
                            : "settings:absent",
                        ),
                        sent: media.sentPackets,
                        received: media.receivedPackets,
                      })
                    : "",
                  call?.phase === "ended"
                    ? call.reason
                      ? t(`calls:${call.reason}`)
                      : call.outcome
                    : "",
                ]
                  .filter(Boolean)
                  .join("\n\n");
                Alert.alert(t("settings:callingDiagnostics"), status);
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? t("settings:checkingCalls") : t("settings:checkCalls")}
          </Action>
        </>
      ) : null}
      {notice ? <Ink accessibilityLiveRegion="polite">{notice}</Ink> : null}
    </Screen>
  );
}
