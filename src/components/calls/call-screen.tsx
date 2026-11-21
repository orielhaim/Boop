import { useAvatar } from "@/core/avatars/use-avatar";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { type ComponentProps, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useStore } from "zustand";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Action, Avatar, Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { ScreenInsets } from "@/components/ui/screen-insets";
import type { AudioRoute, CallView } from "@/core/calling/controller";
import { systemRemoteVideo } from "@/core/calling/system-call-state";
import { type VideoDecision, videoLayout } from "@/core/calling/video";
import { namespaces } from "@/i18n";
import { formatDuration, isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local";
import { space, spring, useTheme } from "@/theme";
import {
  ConferenceSheet,
  ConferenceTiles,
  InvitationStatus,
  useConferencePeers,
} from "./conference";
import { VideoStage } from "./video-stage";

type IconName = ComponentProps<typeof Icon>["name"];

const outcomes = {
  completed: "calls:ended",
  rejected: "calls:rejected",
  cancelled: "calls:callCancelled",
  missed: "calls:missedCall",
  busy: "calls:peerBusy",
  unanswered: "calls:unanswered",
  failed: "calls:failed",
  "remote-disconnected": "calls:disconnected",
} as const;
const phases = {
  outgoing: "calls:dialing",
  ringing: "calls:ringing",
  incoming: "calls:incomingVoice",
  connecting: "calls:connectingPrivate",
  connected: null,
  ending: "calls:ending",
} as const;
const routeLabels = {
  EARPIECE: "calls:earpiece",
  SPEAKER_PHONE: "calls:speaker",
  BLUETOOTH: "calls:bluetooth",
  WIRED_HEADSET: "calls:wiredHeadset",
} satisfies Record<AudioRoute, `calls:${string}`>;
const appear = FadeInDown.duration(200).reduceMotion(ReduceMotion.System);
const reflow = LinearTransition.springify()
  .damping(spring.damping)
  .reduceMotion(ReduceMotion.System);

export function CallScreen({
  name,
  call,
  close,
  focused,
}: {
  name: string;
  call: CallView;
  close: () => void;
  focused: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { calling, lock } = useLocal();
  const avatarFile = useAvatar(call.peerKey, focused);
  const video = useStore(calling.store, (state) => state.video);
  const invitationCount = useStore(
    calling.store,
    (state) => state.invitations.length,
  );
  const peers = useConferencePeers(video);
  const [sheet, setSheet] = useState<"add" | "roster" | null>(null);
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
  const conference = video?.conference;
  const group = connected && !!conference;
  const groupCount = peers.members.length + 1;
  const label = group ? t("calls:groupCall") : name;
  const systemVideo = systemRemoteVideo(call, video, lock.getState().enabled);
  const layout = connected && video ? videoLayout(video) : null;
  const consent = video?.remote.phase === "requesting" ? video.remote : null;
  const cameraOn = !!video && video.local.phase !== "off";
  const videoError = video?.error ? t(`video:error_${video.error}`) : null;
  const respond = (decision: VideoDecision) => {
    if (consent) calling.video()?.respond(consent.sequence, decision);
  };
  const toggleCamera = () => {
    const controls = calling.video();
    if (cameraOn) controls?.disable();
    else void controls?.enable();
  };
  const cameraControl = (compact = false) => (
    <Control
      icon={cameraOn ? "cameraOff" : "camera"}
      label={cameraOn ? t("video:cameraOff") : t("video:camera")}
      selected={cameraOn}
      compact={compact}
      onPress={toggleCamera}
    />
  );
  const end = () => {
    calling.end();
    close();
  };
  const participantActions = connected && call.expandable && (
    <>
      {(group || invitationCount > 0) && (
        <Control
          icon="person"
          label={t("calls:participants")}
          compact
          onPress={() => setSheet("roster")}
        />
      )}
      <Control
        icon="addPerson"
        label={t("calls:addParticipant")}
        compact
        onPress={() => setSheet("add")}
      />
    </>
  );
  const tiles = (mode: "audio" | "rail" | "grid") => (
    <ConferenceTiles
      members={peers.members}
      mode={mode}
      focus={conference?.focus}
      muted={connected && call.muted}
      systemVideoUrl={systemVideo}
      onFocus={(key) => {
        calling.video()?.focus?.(key);
        if (mode === "grid") calling.video()?.mode?.("focus");
      }}
      onWatch={(key) => void calling.video()?.watch?.(key, true)}
    />
  );
  const waiting =
    call.phase === "incoming" ||
    call.phase === "ringing" ||
    call.phase === "outgoing";
  const phaseLabel = call.phase === "ended" ? null : phases[call.phase];
  const status =
    call.phase === "ended"
      ? t(outcomes[call.outcome])
      : call.phase === "connected" && call.reconnecting
        ? t("calls:reconnecting")
        : phaseLabel && t(phaseLabel);
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
      {!reduceTransparency && avatarFile ? (
        <Image
          source={avatarFile}
          cachePolicy="memory"
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
      {focused && connected && video && layout?.stageUrl ? (
        <VideoStage
          stageUrl={layout.stageUrl}
          previewUrl={group ? null : layout.previewUrl}
          systemVideoUrl={systemVideo}
          scene={
            group &&
            conference.mode === "grid" &&
            video.remote.phase === "receiving"
              ? tiles("grid")
              : undefined
          }
          mirrorStage={layout.source === "local" && layout.mirrorLocal}
          mirrorPreview={layout.source === "remote" && layout.mirrorLocal}
          corner={video.corner}
          blockHiding={
            !!consent ||
            showOutput ||
            sheet !== null ||
            !!videoError ||
            outputError ||
            call.reconnecting ||
            video.local.phase === "starting"
          }
          toggleLabel={t("video:toggle")}
          swapLabel={t("video:swap")}
          onSwap={() => calling.video()?.swap()}
          onCorner={(corner) => calling.video()?.setCorner(corner)}
          header={
            <View style={styles.groupHeader}>
              <GlassSurface
                preset="control"
                tint="#1B2335"
                style={styles.videoHeader}
              >
                <Control
                  icon="collapse"
                  label={t("calls:minimize")}
                  compact
                  onPress={close}
                />
                {!group && <Avatar name={name} publicKey={call.peerKey} />}
                <View style={styles.videoIdentity}>
                  <Text numberOfLines={1} style={styles.videoName}>
                    {label}
                  </Text>
                  <Text numberOfLines={1} style={styles.videoCaption}>
                    {call.reconnecting
                      ? t("calls:reconnecting")
                      : group
                        ? t("calls:participantCount", { count: groupCount })
                        : layout.source === "local"
                          ? t("video:local")
                          : t("video:remote")}
                  </Text>
                </View>
                <Elapsed since={call.answeredAt} compact />
                {participantActions}
              </GlassSurface>
              {group && conference.mode === "focus" && tiles("rail")}
              <InvitationStatus onPress={() => setSheet("roster")} />
            </View>
          }
          notice={
            video.local.phase === "waiting" || videoError || outputError ? (
              <Text accessibilityLiveRegion="polite" style={styles.videoNotice}>
                {videoError ??
                  (outputError ? t("calls:routeError") : t("video:waiting"))}
              </Text>
            ) : null
          }
          controls={
            <GlassSurface
              preset="control"
              tint="#1B2335"
              style={styles.videoControls}
            >
              <Control
                icon={call.muted ? "mic" : "microphone"}
                label={call.muted ? t("calls:unmute") : t("calls:mute")}
                selected={call.muted}
                compact
                onPress={calling.mute}
              />
              {cameraControl(true)}
              {"url" in video.local && (
                <Control
                  icon="cameraSwitch"
                  label={t("video:switchCamera")}
                  compact
                  onPress={() => void calling.video()?.switchCamera()}
                />
              )}
              {!!call.routing.available.length && (
                <Control
                  icon="audio"
                  label={t("calls:output")}
                  compact
                  onPress={() => setShowOutput(true)}
                />
              )}
              <Control
                icon="hangup"
                label={t("calls:end")}
                compact
                tint="#BA304B"
                onPress={end}
              />
            </GlassSurface>
          }
        />
      ) : (
        <ScreenInsets style={styles.screen}>
          <View style={styles.top}>
            <Control
              icon="collapse"
              label={
                call.phase === "ended" ? t("common:close") : t("calls:minimize")
              }
              compact
              onPress={close}
            />
            <View style={styles.topSpacer} />
            {participantActions}
          </View>
          <ScrollView contentContainerStyle={styles.content} bounces={false}>
            {group ? (
              <Animated.View
                entering={appear}
                layout={reflow}
                style={styles.identity}
              >
                <Text style={styles.groupName}>{label}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSheet("roster")}
                >
                  <Text style={styles.status}>
                    {t("calls:participantCount", { count: groupCount })}
                  </Text>
                </Pressable>
                <Elapsed since={call.answeredAt} />
                {tiles("audio")}
              </Animated.View>
            ) : (
              <Animated.View
                entering={appear}
                layout={reflow}
                style={styles.identity}
              >
                <View style={styles.portraitRim}>
                  {waiting && <PortraitPulse />}
                  <View
                    style={[
                      styles.portrait,
                      { height: portrait, width: portrait },
                    ]}
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
                    {avatarFile ? (
                      <Image
                        source={avatarFile}
                        cachePolicy="memory"
                        style={StyleSheet.absoluteFill}
                        contentFit="cover"
                      />
                    ) : null}
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("contacts:openProfile", {
                    name: isolateText(name),
                  })}
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
                    <Text
                      style={styles.status}
                      accessibilityLiveRegion="polite"
                    >
                      {status}
                    </Text>
                  </Animated.View>
                )}
                {connected && <Elapsed since={call.answeredAt} />}
                {call.phase === "incoming" && call.inviteCount && (
                  <Text style={styles.reason}>
                    {t("calls:conferenceInvitation")} ·{" "}
                    {t("calls:participantCount", { count: call.inviteCount })}
                  </Text>
                )}
                {call.phase === "ended" && call.reason && (
                  <Text style={styles.reason}>{t(`calls:${call.reason}`)}</Text>
                )}
              </Animated.View>
            )}
            <View style={styles.bottom}>
              {connected && (
                <Animated.View entering={appear} style={styles.controls}>
                  <Control
                    icon={call.muted ? "mic" : "microphone"}
                    label={call.muted ? t("calls:unmute") : t("calls:mute")}
                    selected={call.muted}
                    onPress={calling.mute}
                  />
                  {video && cameraControl()}
                  {call.routing.selected &&
                  call.routing.available.includes("SPEAKER_PHONE") ? (
                    <Control
                      icon="speaker"
                      label={t("calls:speaker")}
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
                      label={t("calls:output")}
                      onPress={() => setShowOutput(true)}
                    />
                  )}
                </Animated.View>
              )}
              {connected && videoError && (
                <Text style={styles.reason} accessibilityLiveRegion="polite">
                  {videoError}
                </Text>
              )}
              {connected && (
                <InvitationStatus onPress={() => setSheet("roster")} />
              )}
              {outputError && connected && (
                <Text style={styles.reason} accessibilityLiveRegion="polite">
                  {t("calls:routeError")}
                </Text>
              )}
              <View style={styles.primary}>
                {call.phase === "incoming" ? (
                  <>
                    <Control
                      icon="hangup"
                      label={t("calls:decline")}
                      tint="#BA304B"
                      onPress={() => {
                        calling.end();
                        close();
                      }}
                    />
                    <Control
                      icon="phone"
                      label={t("calls:answer")}
                      tint="#087959"
                      onPress={calling.accept}
                    />
                  </>
                ) : call.phase === "ended" ? (
                  <Control
                    icon="hangup"
                    label={t("common:done")}
                    onPress={close}
                  />
                ) : call.phase !== "ending" ? (
                  <Control
                    icon="hangup"
                    label={t("calls:end")}
                    iconOnly
                    tint="#BA304B"
                    onPress={end}
                  />
                ) : null}
              </View>
            </View>
          </ScrollView>
        </ScreenInsets>
      )}
      {focused && connected && sheet && (
        <ConferenceSheet
          mode={sheet}
          open
          setOpen={(open) => {
            if (!open) setSheet(null);
          }}
          peers={peers}
          activeVideo={video}
        />
      )}
      {focused && connected && (
        <GlassSheet open={showOutput} onOpenChange={setShowOutput}>
          <GlassSheetContent>
            <GlassSheetTitle>{t("calls:output")}</GlassSheetTitle>
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
                  {t(routeLabels[route])}
                  {call.routing.selected === route ? " ✓" : ""}
                </Text>
              </Pressable>
            ))}
          </GlassSheetContent>
        </GlassSheet>
      )}
      {focused && connected && consent && (
        <GlassSheet
          open
          onOpenChange={(open) => {
            if (!open) respond("deny");
          }}
        >
          <GlassSheetContent>
            <GlassSheetTitle>{t("video:consent")}</GlassSheetTitle>
            <View style={styles.consent}>
              <Ink>{t("video:wants", { name: isolateText(name) })}</Ink>
              {video?.error === "preference" && (
                <Ink kind="caption">{videoError}</Ink>
              )}
              <Action variant="prominent" onPress={() => respond("allow-once")}>
                {t("video:once")}
              </Action>
              {consent.savedContact && (
                <Action onPress={() => respond("allow-always")}>
                  {t("video:always")}
                </Action>
              )}
              <Action onPress={() => respond("deny")}>{t("video:deny")}</Action>
            </View>
          </GlassSheetContent>
        </GlassSheet>
      )}
    </View>
  );
}

function Elapsed({ since, compact }: { since: number; compact?: boolean }) {
  const [now, update] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => update(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1_000));
  return (
    <Text style={[styles.timer, compact && styles.videoTimer]}>
      {formatDuration(seconds)}
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
          compact && (tint ? styles.videoEnd : styles.compact),
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
    flexDirection: "row",
    gap: space.xs,
    alignItems: "flex-start",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  topSpacer: { flex: 1 },
  groupHeader: { width: "100%", gap: 2 },
  groupName: {
    color: "#F5F7FF",
    fontSize: 31,
    fontWeight: "700",
    textAlign: "center",
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
  videoEnd: { width: 56, height: 52 },
  videoControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderRadius: 36,
    padding: 5,
  },
  videoHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 36,
    padding: 6,
    paddingEnd: 14,
  },
  videoIdentity: { flex: 1 },
  videoName: { color: "#F6F8FF", fontSize: 16, fontWeight: "700" },
  videoCaption: { color: "#D6DEF4", fontSize: 12 },
  videoTimer: { fontSize: 16 },
  videoNotice: {
    color: "#FFF",
    backgroundColor: "#151D31EE",
    borderRadius: 22,
    overflow: "hidden",
    paddingHorizontal: 15,
    paddingVertical: 8,
    textAlign: "center",
  },
  consent: { gap: 10, paddingVertical: 14 },
  pressed: { opacity: 0.7 },
  route: { paddingVertical: space.md, minHeight: 44, justifyContent: "center" },
  routeLabel: { fontSize: 16, fontWeight: "600" },
});
