import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Avatar, Hero, IconButton, Ink, Screen } from "@/components/ui/kit";
import type { CallState } from "@/core/calling/lifecycle";
import { callingUnavailable } from "@/core/calling/transport";
import { space } from "@/theme";

type Controls = {
  mute: (muted: boolean) => void;
  speaker: (on: boolean) => void;
  end: () => void;
};

export function CallScreen({
  name,
  avatarUrl,
  state,
  controls,
}: {
  name: string;
  avatarUrl?: string | null;
  state: CallState;
  controls?: Controls;
}) {
  const startedAt = state.phase === "active" ? state.startedAt : null;
  const [now, setNow] = useState(Date.now);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds =
    startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = [Math.floor(seconds / 60), seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const active = state.phase === "active" && controls !== undefined;
  const status = {
    idle: "Ready",
    outgoing: "Starting call",
    incoming: "Incoming call",
    ringing: "Ringing",
    connecting: "Connecting",
    active: "Connected",
    ended: "Call ended",
    failed: "Call unavailable",
  }[state.phase];
  const close = () => {
    controls?.end();
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  return (
    <Screen>
      <Hero>
        <View style={styles.hero}>
          <Avatar name={name} uri={avatarUrl} size="xl" />
          <Ink kind="title" style={styles.center}>
            {name}
          </Ink>
          <Ink muted accessibilityLiveRegion="polite" style={styles.center}>
            {status}
          </Ink>
          {startedAt !== null ? (
            <Ink kind="heading" style={styles.center}>
              {elapsed}
            </Ink>
          ) : null}
        </View>
      </Hero>
      {state.phase === "failed" ? (
        <Ink muted style={styles.center}>
          {callingUnavailable}
        </Ink>
      ) : null}
      <View style={styles.controls}>
        <View style={styles.control}>
          <IconButton
            icon="mic"
            label={muted ? "Unmute" : "Mute"}
            disabled={!active}
            tone={muted ? "accent" : "normal"}
            onPress={() => {
              controls?.mute(!muted);
              setMuted(!muted);
            }}
          />
          <Ink kind="caption" muted>
            {muted ? "Unmute" : "Mute"}
          </Ink>
        </View>
        <View style={styles.control}>
          <IconButton
            icon="speaker"
            label={speaker ? "Turn speaker off" : "Turn speaker on"}
            disabled={!active}
            tone={speaker ? "accent" : "normal"}
            onPress={() => {
              controls?.speaker(!speaker);
              setSpeaker(!speaker);
            }}
          />
          <Ink kind="caption" muted>
            Speaker
          </Ink>
        </View>
        <View style={styles.control}>
          <IconButton
            icon="missed"
            label={controls ? "End call" : "Close call screen"}
            tone="danger"
            onPress={close}
          />
          <Ink kind="caption" muted>
            {controls ? "End" : "Close"}
          </Ink>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.md, paddingVertical: space.xxl },
  center: { textAlign: "center" },
  controls: {
    flexDirection: "row",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.xl,
    paddingVertical: space.xl,
  },
  control: { alignItems: "center", gap: space.sm, minWidth: 56 },
});
