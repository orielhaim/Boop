import Constants from "expo-constants";
import { router } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Action, Ink, Screen, Section } from "@/components/ui/kit";
import { useLocal } from "@/services/local";

export default function About() {
  const { db, identity, chat, calling, messaging } = useLocal();
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const config = Constants.expoConfig;
  return (
    <Screen>
      <SettingsGroup title="Boop">
        <SettingsRow
          title="Version"
          value={config?.version ?? "Unknown"}
          icon="info"
        />
        <SettingsRow
          title="Build"
          value={String(
            config?.ios?.buildNumber ?? config?.android?.versionCode ?? 1,
          )}
          icon="settings"
        />
      </SettingsGroup>

      {__DEV__ ? (
        <>
          <Section>Development</Section>
          <Action
            disabled={seeding}
            onPress={async () => {
              setSeeding(true);
              try {
                const fixture = await import("@/db/chat-stress");
                const { peerKey } = fixture.seedStressConversations(
                  db,
                  identity.publicKey,
                );
                chat.invalidate();
                router.push({
                  pathname: "/chat/[key]",
                  params: { key: peerKey },
                });
              } catch {
                setNotice("Could not open the chat stress scenario.");
              } finally {
                setSeeding(false);
              }
            }}
          >
            {seeding
              ? "Preparing test history…"
              : "Open 10,000-message test chat"}
          </Action>
          <Action
            onPress={async () => {
              const kit = await import("@kesha-antonov/react-native-chat");
              const capabilities = kit.getChatCapabilities();
              const available = Object.entries(capabilities)
                .flatMap(([name, enabled]) => (enabled ? [name] : []))
                .join(", ");
              setNotice(
                `Available Chat Kit capabilities: ${available || "none"}.`,
              );
            }}
          >
            Check chat capabilities
          </Action>
          <Action
            disabled={checking}
            onPress={async () => {
              setChecking(true);
              try {
                const { checkNativeCalling } =
                  await import("@/core/calling/native-check");
                const call = calling.store.getState().call;
                const media = await calling.inspect()?.catch(() => undefined);
                const status = [
                  await checkNativeCalling(),
                  `Call state: ${call?.phase ?? "idle"}. Inbox transport: ${messaging.getStatus()}.`,
                  call?.phase === "connected"
                    ? `Audio output: ${call.routing.selected ?? "system managed"}.`
                    : "",
                  media
                    ? `ICE: ${media.ice}. Microphone: ${media.microphone ? "on" : "off"}. Remote audio track: ${media.remoteTrack ? "present" : "absent"}. Audio RTP packets sent / received: ${media.sentPackets} / ${media.receivedPackets}.`
                    : "",
                  call?.phase === "ended" ? (call.reason ?? call.outcome) : "",
                ]
                  .filter(Boolean)
                  .join("\n\n");
                Alert.alert("Calling diagnostics", status);
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking calling runtime…" : "Check calling runtime"}
          </Action>
        </>
      ) : null}
      {notice ? <Ink accessibilityLiveRegion="polite">{notice}</Ink> : null}
    </Screen>
  );
}
