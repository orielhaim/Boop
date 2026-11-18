import { Host, Switch } from "@expo/ui";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import {
  Action,
  Avatar,
  Card,
  Hero,
  Icon,
  Ink,
  layout,
  Screen,
  Section,
} from "@/components/ui/kit";
import { RelaySettings } from "@/components/ui/relay-settings";
import { checkNativeCalling } from "@/core/calling/native-check";
import { setPreference } from "@/db/queries";
import { useLocal } from "@/services/local";
import { themes, useAppPreferences } from "@/stores/preferences";
import { radius, space, useTheme } from "@/theme";

export default function Settings() {
  const { qr: showQr } = useLocalSearchParams<{ qr?: string }>();
  const { db, identity, chat } = useLocal();
  const { theme, colors } = useTheme();
  const selected = useAppPreferences((state) => state.theme);
  const haptics = useAppPreferences((state) => state.haptics);
  const [qr, setQR] = useState(showQr === "1");
  const [copyNotice, setCopyNotice] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const { width } = useWindowDimensions();

  async function copy() {
    try {
      const copied = await Clipboard.setStringAsync(identity.npub);
      setCopyNotice(copied ? "Address copied." : "Could not copy the address.");
    } catch {
      setCopyNotice("Could not copy the address.");
    }
  }

  return (
    <Screen>
      <Hero>
        <View style={styles.identity}>
          <Avatar name="Boop" size="xl" />
          <Ink kind="heading" accessibilityRole="header">
            Your Boop address
          </Ink>
          <Ink kind="caption" selectable style={styles.address}>
            {identity.npub}
          </Ink>
          <View style={styles.identityActions}>
            <Action size="sm" onPress={copy}>
              <Icon name="copy" size={16} />
              Copy address
            </Action>
            <Action size="sm" onPress={() => setQR(true)}>
              <Icon name="qr" size={16} />
              Show QR code
            </Action>
          </View>
          {copyNotice ? (
            <Ink kind="caption" accessibilityLiveRegion="polite">
              {copyNotice}
            </Ink>
          ) : null}
        </View>
      </Hero>
      <GlassSheet open={qr} onOpenChange={setQR}>
        <GlassSheetContent side="bottom">
          <GlassSheetTitle>Your Boop address</GlassSheetTitle>
          <View
            accessible
            accessibilityLabel="QR code for your public key"
            style={styles.qr}
          >
            {qr ? (
              <QRCode
                value={`nostr:${identity.npub}`}
                size={Math.min(220, Math.max(128, width - 116))}
              />
            ) : null}
          </View>
        </GlassSheetContent>
      </GlassSheet>
      <Section>Preferences</Section>
      <Card>
        <View style={styles.preference}>
          <View style={layout.row}>
            <Icon name="chat" />
            <Ink kind="label">Appearance</Ink>
          </View>
          <GlassSegmentedControl
            value={selected}
            accessibilityLabel="Theme"
            onValueChange={(value) => {
              const choice = themes.find((item) => item === value);
              if (!choice) return;
              try {
                setPreference(db, "theme", choice);
                useAppPreferences.setState({ theme: choice });
                setNotice("");
              } catch {
                setNotice("Could not save the theme.");
              }
            }}
          >
            <GlassSegmentedControlItem value="system">
              System
            </GlassSegmentedControlItem>
            <GlassSegmentedControlItem value="light">
              Light
            </GlassSegmentedControlItem>
            <GlassSegmentedControlItem value="dark">
              Dark
            </GlassSegmentedControlItem>
          </GlassSegmentedControl>
        </View>
        <View style={[styles.switch, { borderTopColor: colors.line }]}>
          <Host matchContents colorScheme={theme} seedColor={colors.accent}>
            <Switch
              label="Haptic feedback"
              value={haptics}
              onValueChange={(value) => {
                try {
                  setPreference(db, "haptics", value ? "on" : "off");
                  useAppPreferences.setState({ haptics: value });
                  setNotice("");
                } catch {
                  setNotice("Could not save haptic preferences.");
                }
              }}
            />
          </Host>
        </View>
      </Card>
      <Section>Network</Section>
      <Card>
        <RelaySettings />
      </Card>
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
                setNotice(await checkNativeCalling());
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

const styles = StyleSheet.create({
  qr: {
    backgroundColor: "#FFFFFF",
    borderRadius: radius.input,
    alignSelf: "center",
    padding: space.lg,
    margin: space.lg,
  },
  identity: { alignItems: "center", gap: space.md },
  address: { textAlign: "center" },
  identityActions: {
    ...layout.row,
    justifyContent: "center",
  },
  preference: { gap: space.md, padding: space.lg },
  switch: { padding: space.lg, borderTopWidth: StyleSheet.hairlineWidth },
});
