import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ComponentProps, useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeInDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Icon, tapFeedback } from "@/components/ui/kit";
import type { AudioRoute, CallView } from "@/core/calling/controller";
import { useLocal } from "@/services/local";
import { space, spring, useTheme } from "@/theme";

type IconName = ComponentProps<typeof Icon>["name"];

const outcomes = {
  completed: "Call ended",
  rejected: "Call declined",
  cancelled: "Call cancelled",
  missed: "Missed call",
  busy: "The other person is busy",
  unanswered: "No answer",
  failed: "Connection failed",
  "remote-disconnected": "Connection lost",
};
const phases = {
  outgoing: "Calling…",
  ringing: "Ringing…",
  incoming: "Incoming voice call",
  connecting: "Connecting privately…",
  connected: null,
  ending: "Ending call…",
};
const routeLabels: Record<AudioRoute, string> = {
  EARPIECE: "Phone or system default",
  SPEAKER_PHONE: "Speaker",
  BLUETOOTH: "Bluetooth headset",
  WIRED_HEADSET: "Wired headset",
};
const appear = FadeInDown.duration(200).reduceMotion(ReduceMotion.System);
const reflow = LinearTransition.springify()
  .damping(spring.damping)
  .reduceMotion(ReduceMotion.System);

export function CallScreen({
  name,
  avatarUrl,
  call,
  close,
}: {
  name: string;
  avatarUrl?: string | null;
  call: CallView;
  close: () => void;
}) {
  const { calling } = useLocal();
  const [showOutput, setShowOutput] = useState(false);
  const [outputError, setOutputError] = useState(false);
  const { height, width } = useWindowDimensions();
  const { colors, reduceTransparency } = useTheme();
  const portrait = Math.max(
    92,
    Math.min(
      width * 0.45,
      height * (call.phase === "connected" ? 0.2 : 0.24),
      192,
    ),
  );
  const connected = call.phase === "connected";
  const waiting =
    call.phase === "incoming" ||
    call.phase === "ringing" ||
    call.phase === "outgoing";
  const status =
    call.phase === "ended"
      ? outcomes[call.outcome]
      : call.phase === "connected" && call.reconnecting
        ? "Reconnecting…"
        : phases[call.phase];
  const openChat = () =>
    router.push({ pathname: "/chat/[key]", params: { key: call.peerKey } });
  const selectRoute = async (route: AudioRoute) => {
    try {
      await calling.route(route);
      setOutputError(false);
      setShowOutput(false);
    } catch {
      setOutputError(true);
    }
  };

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {!reduceTransparency && avatarUrl ? (
        <Image
          source={avatarUrl}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          blurRadius={60}
        />
      ) : null}
      <LinearGradient
        colors={["#1A2649E6", "#222C56EB", "#0B1326FA"]}
        locations={[0, 0.48, 1]}
        style={StyleSheet.absoluteFill}
      />
      {!reduceTransparency && (
        <View pointerEvents="none" style={styles.orbit} />
      )}
      <SafeAreaView
        style={styles.screen}
        edges={["top", "bottom", "left", "right"]}
      >
        <View style={styles.top}>
          <Control
            icon="collapse"
            label={call.phase === "ended" ? "Close" : "Minimize"}
            compact
            onPress={close}
          />
        </View>
        <ScrollView contentContainerStyle={styles.content} bounces={false}>
          <Animated.View
            entering={appear}
            layout={reflow}
            style={styles.identity}
          >
            <View style={styles.portraitRim}>
              {waiting && <PortraitPulse />}
              <View
                style={[styles.portrait, { height: portrait, width: portrait }]}
              >
                <LinearGradient
                  colors={["#6178BC", "#3F4597", "#2F315A"]}
                  style={StyleSheet.absoluteFill}
                />
                <Text
                  accessible={false}
                  style={[styles.initials, { fontSize: portrait * 0.36 }]}
                >
                  {name.startsWith("npub")
                    ? "•"
                    : Array.from(name.trim())[0]?.toLocaleUpperCase()}
                </Text>
                {avatarUrl ? (
                  <Image
                    source={avatarUrl}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                  />
                ) : null}
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open contact for ${name}`}
              onPress={() => {
                tapFeedback();
                router.push({
                  pathname: "/contact/[key]",
                  params: { key: call.peerKey },
                });
              }}
            >
              <Text numberOfLines={2} style={styles.name}>
                {name}
              </Text>
            </Pressable>
            {status && (
              <Animated.View
                key={call.phase}
                entering={FadeIn.duration(180).reduceMotion(
                  ReduceMotion.System,
                )}
                style={styles.statusRow}
              >
                <View style={styles.statusDot} />
                <Text style={styles.status} accessibilityLiveRegion="polite">
                  {status}
                </Text>
              </Animated.View>
            )}
            {connected && <Elapsed since={call.answeredAt} />}
            {call.phase === "ended" && call.reason && (
              <Text style={styles.reason}>{call.reason}</Text>
            )}
          </Animated.View>
          <View style={styles.bottom}>
            {connected && (
              <Animated.View entering={appear} style={styles.controls}>
                <Control
                  icon="mic"
                  label={call.muted ? "Unmute" : "Mute"}
                  selected={call.muted}
                  onPress={calling.mute}
                />
                {call.routing.selected &&
                call.routing.available.includes("SPEAKER_PHONE") ? (
                  <Control
                    icon="speaker"
                    label="Speaker"
                    selected={call.routing.selected === "SPEAKER_PHONE"}
                    onPress={() => {
                      const next =
                        call.routing.selected === "SPEAKER_PHONE"
                          ? call.routing.available.find(
                              (route) => route !== "SPEAKER_PHONE",
                            )
                          : "SPEAKER_PHONE";
                      if (next) void selectRoute(next);
                    }}
                  />
                ) : null}
                {!!call.routing.available.length && (
                  <Control
                    icon="audio"
                    label="Audio output"
                    onPress={() => setShowOutput(true)}
                  />
                )}
                <Control icon="chat" label="Messages" onPress={openChat} />
              </Animated.View>
            )}
            {outputError && connected && (
              <Text style={styles.reason} accessibilityLiveRegion="polite">
                Could not change audio output.
              </Text>
            )}
            <View style={styles.primary}>
              {call.phase === "incoming" ? (
                <>
                  <Control
                    icon="hangup"
                    label="Decline"
                    tint="#BA304B"
                    onPress={() => {
                      calling.end();
                      close();
                    }}
                  />
                  <Control
                    icon="phone"
                    label="Answer"
                    tint="#087959"
                    onPress={calling.accept}
                  />
                </>
              ) : call.phase === "ended" ? (
                <>
                  <Control icon="chat" label="Message" onPress={openChat} />
                  <Control icon="hangup" label="Done" onPress={close} />
                </>
              ) : call.phase !== "ending" ? (
                <Control
                  icon="hangup"
                  label="End call"
                  iconOnly
                  tint="#BA304B"
                  onPress={() => {
                    calling.end();
                    close();
                  }}
                />
              ) : null}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
      {connected && (
        <GlassSheet open={showOutput} onOpenChange={setShowOutput}>
          <GlassSheetContent>
            <GlassSheetTitle>Audio output</GlassSheetTitle>
            {call.routing.available.map((route) => (
              <Pressable
                key={route}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: call.routing.selected === route,
                }}
                onPress={() => {
                  tapFeedback();
                  void selectRoute(route);
                }}
                style={styles.route}
              >
                <Text
                  style={[
                    styles.routeLabel,
                    {
                      color:
                        call.routing.selected === route
                          ? colors.accent
                          : colors.text,
                    },
                  ]}
                >
                  {routeLabels[route]}
                  {call.routing.selected === route ? " ✓" : ""}
                </Text>
              </Pressable>
            ))}
          </GlassSheetContent>
        </GlassSheet>
      )}
    </View>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, update] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => update(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1_000));
  return (
    <Text style={styles.timer}>
      {String(Math.floor(seconds / 60)).padStart(2, "0")}:
      {String(seconds % 60).padStart(2, "0")}
    </Text>
  );
}

function PortraitPulse() {
  const { reduceMotion } = useTheme();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(withTiming(1, { duration: 2300 }), -1, false);
    return () => {
      cancelAnimation(pulse);
      pulse.value = 0;
    };
  }, [pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.62 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 0.19 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.pulse, style]}
    />
  );
}

function Control({
  icon,
  label,
  onPress,
  tint,
  selected,
  compact,
  iconOnly,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  selected?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [styles.control, pressed && styles.pressed]}
    >
      <GlassSurface
        preset="control"
        elevation="none"
        tint={tint ?? (selected ? "#3E55A1" : "#26345D")}
        style={[
          styles.button,
          tint && styles.strong,
          compact && styles.compact,
        ]}
      >
        <Icon name={icon} size={tint ? 29 : 23} color="#F9FAFF" />
      </GlassSurface>
      {!compact && !iconOnly && (
        <Text numberOfLines={1} style={styles.controlLabel}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "transparent" },
  orbit: {
    position: "absolute",
    width: 470,
    height: 470,
    top: 60,
    alignSelf: "center",
    borderRadius: 300,
    borderWidth: 1,
    borderColor: "#B0BFFF13",
  },
  top: {
    alignItems: "flex-start",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  content: {
    flexGrow: 1,
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xl,
    gap: space.xl,
  },
  identity: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
  },
  portraitRim: {
    borderWidth: 1,
    padding: 7,
    borderRadius: 999,
    borderColor: "#D6DEFF60",
    backgroundColor: "#9DB4FF12",
  },
  pulse: {
    borderWidth: 1,
    borderColor: "#ACC0FF",
    borderRadius: 999,
  },
  portrait: {
    borderRadius: 999,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: "#F3F5FF", fontWeight: "600" },
  name: {
    color: "#F6F8FF",
    fontSize: 36,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -1.1,
  },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 99,
    backgroundColor: "#B7C4FB",
  },
  status: { color: "#D1DBFC", fontSize: 16, fontWeight: "500" },
  reason: {
    color: "#D1DBFC",
    fontSize: 14,
    textAlign: "center",
    maxWidth: 310,
  },
  timer: {
    color: "#F3F6FF",
    fontSize: 28,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  bottom: { alignItems: "center", gap: space.lg },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space.md,
  },
  primary: { flexDirection: "row", justifyContent: "center", gap: 46 },
  control: { alignItems: "center", gap: space.sm },
  controlLabel: { color: "#E5EAFF", fontSize: 13, fontWeight: "500" },
  button: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  strong: { width: 74, height: 74 },
  compact: { width: 44, height: 44 },
  pressed: { opacity: 0.7 },
  route: { paddingVertical: space.md, minHeight: 44, justifyContent: "center" },
  routeLabel: { fontSize: 16, fontWeight: "600" },
});
