import type { AudioTrack, VideoContentFit, VideoPlayer } from "expo-video";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  GlassTray,
  GlassTrayScreen,
  useGlassTray,
  type TrayCoverage,
} from "@/components/glassyui/glass-tray";
import { Icon, type IconName } from "@/components/ui/icon";
import { Ruler } from "@/components/ui/ruler";
import { Switch } from "@/components/ui/switch";
import { updateVideoPlayer } from "@/core/video/player-settings";
import { MenuRow } from "./menu-row";

export type PlaybackTrayScreen = "options" | "subtitles";
export type SubtitleTrayScreen = "main" | "appearance" | "encoding" | "timing";

type PlaybackTrayProps = {
  open: boolean;
  initialScreen: PlaybackTrayScreen;
  onClose(): void;
  player: VideoPlayer;
  audioTracks: readonly AudioTrack[];
  audioTrack: AudioTrack | null;
  subtitleValue?: string;
  onSelectAudioTrack(track: AudioTrack): void;
  renderSubtitles?: (screen: SubtitleTrayScreen) => ReactNode;
  playbackRate: number;
  fit: VideoContentFit;
  onFitChange(fit: VideoContentFit): void;
  loop: boolean;
  onLoopChange(loop: boolean): void;
  background: boolean;
  allowBackground: boolean;
  onBackgroundChange?(enabled: boolean): void;
  onShare?(): void;
  onSave?(): void;
  onExternal?(): void;
  onOrigin?(): void;
  onCoverageChange?: (coverage: TrayCoverage) => void;
  videoInfo: {
    dimensions?: string;
    duration?: string;
    audioTrack?: string;
    subtitleTrack?: string;
  };
};

function TrayContent({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

function trackName(track: AudioTrack) {
  return track.label || track.name || track.language;
}

function Toggle({
  label,
  icon,
  checked,
  onChange,
}: {
  label: string;
  icon: IconName;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Icon name={icon} size={20} />
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        checked={checked}
        onCheckedChange={onChange}
      />
    </View>
  );
}

function PlaybackOptions(props: PlaybackTrayProps) {
  const { t } = useTranslation("video");
  const { push } = useGlassTray();
  return (
    <TrayContent>
      <View style={styles.group}>
        <MenuRow
          label={t("viewer.speed")}
          detail={formatRate(props.playbackRate)}
          icon="time"
          navigates
          action={() => push("speed")}
        />
        {props.renderSubtitles && (
          <MenuRow
            label={t("viewer.subtitles")}
            detail={props.subtitleValue ?? t("viewer.subtitlesOff")}
            icon="captions"
            navigates
            action={() => push("subtitles")}
          />
        )}
        {props.audioTracks.length > 1 && (
          <MenuRow
            label={t("viewer.audio")}
            detail={props.audioTrack ? trackName(props.audioTrack) : undefined}
            icon="speaker"
            navigates
            action={() => push("audio")}
          />
        )}
        {!props.background && (
          <MenuRow
            label={t("viewer.aspect")}
            detail={t(props.fit === "contain" ? "viewer.fit" : "viewer.fill")}
            icon="fullscreen"
            navigates
            action={() => push("display")}
          />
        )}
      </View>
      <View style={styles.group}>
        <Toggle
          label={t("viewer.repeat")}
          icon="repeat"
          checked={props.loop}
          onChange={props.onLoopChange}
        />
        {props.allowBackground && props.onBackgroundChange && (
          <Toggle
            label={t("viewer.backgroundPlayback")}
            icon="audio"
            checked={props.background}
            onChange={props.onBackgroundChange}
          />
        )}
      </View>
      {(props.onShare ||
        props.onSave ||
        props.onExternal ||
        props.onOrigin ||
        Object.values(props.videoInfo).some(Boolean)) && (
        <MenuRow
          label={t("viewer.fileActions")}
          icon="file"
          navigates
          action={() => push("file")}
        />
      )}
    </TrayContent>
  );
}

const speedMinimum = 25;
const speedMaximum = 300;
const speedStep = 5;
const speedTicks = Array.from(
  { length: (speedMaximum - speedMinimum) / speedStep + 1 },
  (_, index) => ({ major: (speedMinimum + index * speedStep) % 25 === 0 }),
);
const displays = ["contain", "cover"] as const;

function formatRate(rate: number) {
  return `${Number(rate.toFixed(2))}×`;
}

function SpeedOptions({ player, rate }: { player: VideoPlayer; rate: number }) {
  const { t } = useTranslation("video");
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<number>();
  const changeRate = useCallback(
    (index: number) => {
      const playbackRate = (speedMinimum + index * speedStep) / 100;
      if (Math.abs(player.playbackRate - playbackRate) > 0.001)
        updateVideoPlayer(player, { playbackRate });
      setPreview(undefined);
    },
    [player],
  );
  const index = Math.max(
    0,
    Math.min(
      speedTicks.length - 1,
      Math.round((rate * 100 - speedMinimum) / speedStep),
    ),
  );
  const rateText = formatRate(
    preview === undefined ? rate : (speedMinimum + preview * speedStep) / 100,
  );

  return (
    <TrayContent>
      <Text accessible={false} style={styles.speedReadout}>
        {rateText}
      </Text>
      <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
        {width > 0 && (
          <Ruler
            width={width}
            ticks={speedTicks}
            value={index}
            onValueChange={setPreview}
            onValueCommit={changeRate}
            label={t("viewer.speed")}
            valueText={rateText}
          />
        )}
      </View>
      <View style={styles.speedRange} accessible={false}>
        <Text style={styles.infoLabel}>0.25×</Text>
        <Text style={styles.infoLabel}>3×</Text>
      </View>
    </TrayContent>
  );
}

function DisplayOptions({
  fit,
  change,
}: {
  fit: VideoContentFit;
  change: (fit: VideoContentFit) => void;
}) {
  const { t } = useTranslation("video");
  return (
    <TrayContent>
      <View style={styles.cards}>
        {displays.map((option) => (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: fit === option }}
            style={({ pressed }) => [
              styles.choice,
              fit === option && styles.chosen,
              pressed && styles.pressed,
            ]}
            onPress={() => change(option)}
          >
            <View style={styles.displayFrame}>
              <View
                style={[
                  styles.displayImage,
                  option === "cover" && styles.displayCropped,
                ]}
              />
            </View>
            <Text style={styles.value}>
              {t(option === "contain" ? "viewer.fit" : "viewer.fill")}
            </Text>
          </Pressable>
        ))}
      </View>
    </TrayContent>
  );
}

function FileOptions({
  onClose,
  onShare,
  onSave,
  onExternal,
  onOrigin,
  videoInfo,
}: PlaybackTrayProps) {
  const { t } = useTranslation("video");
  const actions = [
    { key: "share", icon: "share", action: onShare },
    { key: "save", icon: "download", action: onSave },
    { key: "external", icon: "openExternal", action: onExternal },
    { key: "origin", icon: "chat", action: onOrigin },
  ] as const;
  const info = [
    "dimensions",
    "duration",
    "audioTrack",
    "subtitleTrack",
  ] as const;
  return (
    <TrayContent>
      {actions.some(({ action }) => action) && (
        <View style={styles.group}>
          {actions.map(
            ({ key, icon, action }) =>
              action && (
                <MenuRow
                  key={key}
                  label={t(`viewer.${key}`)}
                  icon={icon}
                  action={() => {
                    onClose();
                    action();
                  }}
                />
              ),
          )}
        </View>
      )}
      <View style={styles.group}>
        {info.map(
          (key) =>
            videoInfo[key] && (
              <View key={key} style={styles.info}>
                <Text style={styles.infoLabel}>{t(`viewer.info.${key}`)}</Text>
                <Text style={styles.value}>{videoInfo[key]}</Text>
              </View>
            ),
        )}
      </View>
    </TrayContent>
  );
}

export function PlaybackTray(props: PlaybackTrayProps) {
  const { t } = useTranslation("video");
  return (
    <GlassTray
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      initialScreen={props.initialScreen}
      onCoverageChange={props.onCoverageChange}
    >
      <GlassTrayScreen name="options" title={t("viewer.options")}>
        <PlaybackOptions {...props} />
      </GlassTrayScreen>
      <GlassTrayScreen name="speed" title={t("viewer.speed")}>
        <SpeedOptions player={props.player} rate={props.playbackRate} />
      </GlassTrayScreen>
      <GlassTrayScreen name="audio" title={t("viewer.audio")}>
        <TrayContent>
          <View style={styles.group}>
            {props.audioTracks.map((track, index) => (
              <MenuRow
                key={track.id ?? index}
                label={
                  trackName(track) ||
                  t("viewer.trackNumber", { number: index + 1 })
                }
                detail={track.label ? track.language : undefined}
                selected={props.audioTrack?.id === track.id}
                action={() => props.onSelectAudioTrack(track)}
              />
            ))}
          </View>
        </TrayContent>
      </GlassTrayScreen>
      <GlassTrayScreen name="display" title={t("viewer.aspect")}>
        <DisplayOptions fit={props.fit} change={props.onFitChange} />
      </GlassTrayScreen>
      <GlassTrayScreen name="file" title={t("viewer.fileActions")}>
        <FileOptions {...props} />
      </GlassTrayScreen>
      <GlassTrayScreen name="subtitles" title={t("viewer.subtitles")}>
        <TrayContent>{props.renderSubtitles?.("main")}</TrayContent>
      </GlassTrayScreen>
      <GlassTrayScreen
        name="subtitle-appearance"
        title={t("viewer.captionStyle")}
      >
        <TrayContent>{props.renderSubtitles?.("appearance")}</TrayContent>
      </GlassTrayScreen>
      <GlassTrayScreen
        name="subtitle-encoding"
        title={t("viewer.subtitleEncoding")}
      >
        <TrayContent>{props.renderSubtitles?.("encoding")}</TrayContent>
      </GlassTrayScreen>
      <GlassTrayScreen
        name="subtitle-timing"
        title={t("viewer.subtitleTiming")}
      >
        <TrayContent>{props.renderSubtitles?.("timing")}</TrayContent>
      </GlassTrayScreen>
    </GlassTray>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: { flexShrink: 1 },
  content: { padding: theme.space.md, gap: theme.space.sm },
  group: {
    backgroundColor: theme.colors.grouped,
    borderRadius: theme.radius.group,
    padding: theme.space.xs,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    gap: theme.space.sm,
    paddingHorizontal: theme.space.md,
  },
  toggleLabel: { ...theme.type.label, color: theme.colors.text, flex: 1 },
  speedReadout: {
    ...theme.type.screenTitle,
    alignSelf: "center",
    color: theme.colors.accent,
    fontVariant: ["tabular-nums"],
    paddingVertical: theme.space.sm,
  },
  speedRange: {
    flexDirection: "row",
    justifyContent: "space-between",
    direction: "ltr",
  },
  cards: { flexDirection: "row", gap: theme.space.sm },
  choice: {
    flex: 1,
    gap: theme.space.sm,
    borderRadius: theme.radius.group,
    alignItems: "center",
    padding: theme.space.md,
    backgroundColor: theme.colors.grouped,
  },
  chosen: {
    backgroundColor: theme.colors.selected,
    boxShadow: `inset 0px 0px 0px 1px ${theme.colors.accent}`,
  },
  pressed: { opacity: 0.66 },
  displayFrame: {
    width: "100%",
    aspectRatio: 1.7,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.muted,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.recessed,
  },
  displayImage: {
    width: "100%",
    height: "58%",
    backgroundColor: theme.colors.accent,
    opacity: 0.64,
  },
  displayCropped: { width: "100%", height: "100%" },
  value: {
    ...theme.type.control,
    color: theme.colors.text,
    fontVariant: ["tabular-nums"],
  },
  info: {
    minHeight: 37,
    paddingHorizontal: theme.space.md,
    gap: theme.space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  infoLabel: { ...theme.type.caption, color: theme.colors.muted },
}));
