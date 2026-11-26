import type { PlaybackSource } from "@hzblj/expo-speech";
import { MessageAudio, type IMessage } from "@kesha-antonov/react-native-chat";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStore } from "zustand";
import { Icon, Ink } from "@/components/ui/kit";
import type { useVoiceTranscript } from "@/components/messages/voice-transcript";
import { trackId, type Track } from "@/core/audio/types";
import { useTheme } from "@/theme";
import { useAudioActions, useAudioTrack } from "./actions";
import { SpeedControl } from "./controls";

function AttachmentProgress({
  label,
  progress,
  outgoing,
  cancel,
}: {
  label: string;
  progress?: number;
  outgoing: boolean;
  cancel?: () => void;
}) {
  const { colors } = useTheme();
  const { i18n } = useTranslation();
  const color = outgoing ? colors.outgoingInk : colors.accent;
  const value =
    progress == null
      ? undefined
      : Math.floor(Math.max(0, Math.min(1, progress)) * 100);
  const content = (
    <>
      <ActivityIndicator
        size={44}
        color={color}
        style={StyleSheet.absoluteFill}
      />
      {value !== undefined && (
        <Ink kind="caption" style={{ color }}>
          {new Intl.NumberFormat(i18n.resolvedLanguage, {
            style: "percent",
          }).format(value / 100)}
        </Ink>
      )}
    </>
  );
  const status = { min: 0, max: 100, now: value };
  return cancel ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={status}
      onPress={cancel}
      style={styles.play}
    >
      {content}
    </Pressable>
  ) : (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={status}
      style={styles.play}
    >
      {content}
    </View>
  );
}

function AttachmentAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: "download" | "refresh";
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={[styles.play, { backgroundColor: colors.selected }]}
    >
      <Icon name={icon} size={22} color={colors.accent} />
    </Pressable>
  );
}

export function VoiceUploadAttachment({
  message,
  duration,
  waveform,
  progress,
  retry,
}: {
  message: IMessage;
  duration?: number;
  waveform?: number[];
  progress: number;
  retry?: () => void;
}) {
  const { t } = useTranslation(["messages", "common"]);
  return (
    <MessageAudio
      currentMessage={{ ...message, duration, waveform: waveform ?? [] }}
      position="right"
      controlledPlayback={{
        control: retry ? (
          <AttachmentAction
            icon="refresh"
            label={t("common:retry")}
            onPress={retry}
          />
        ) : (
          <AttachmentProgress
            label={t("messages:voiceUpload_uploading")}
            outgoing
            progress={progress}
          />
        ),
      }}
    />
  );
}

type TrackProps = {
  track: Track;
  ready: boolean;
  checking: boolean;
  downloading: boolean;
  progress?: number;
  outgoing: boolean;
  authorize(): boolean;
};

function useAttachmentPlayback({
  track,
  ready,
  checking,
  downloading,
  authorize,
}: TrackProps) {
  const { open } = useAudioActions();
  const id = trackId(track);
  const { audio, downloads, current } = useAudioTrack(id);
  const blocked = useStore(audio.store, (state) => state.blocked);
  const preparing = useStore(
    audio.store,
    (state) => state.preparingVoice === id,
  );
  const playing = current?.phase === "playing";
  const waiting = preparing || current?.phase === "loading" || downloading;

  function press() {
    if (blocked || checking || !authorize()) return;
    if (waiting) {
      if (preparing) audio.cancelVoice(id);
      else if (current?.phase === "loading") audio.stop();
      if (downloading) void downloads.cancel(id).catch(() => undefined);
    } else if (
      ready &&
      current &&
      (playing || (track.voice && current.phase !== "error"))
    )
      audio.toggle();
    else void open(track, undefined, !ready);
  }

  return { audio, id, current, blocked, playing, waiting, press };
}

export function VoiceMessageAttachment({
  message,
  transcript,
  ...props
}: TrackProps & {
  message: IMessage;
  transcript: ReturnType<typeof useVoiceTranscript>;
}) {
  const { t } = useTranslation(["audio", "messages", "common"]);
  const { audio, id, current, blocked, playing, waiting, press } =
    useAttachmentPlayback(props);
  const clock = useMemo(
    () => ({
      get currentTime() {
        return audio.store.getState().current?.position ?? 0;
      },
      get playing() {
        return audio.store.getState().current?.phase === "playing";
      },
      get playbackRate() {
        return audio.store.getState().speed;
      },
      addListener(
        event: string,
        listener: (value: {
          currentTime: number;
          playbackRate: number;
          playing: boolean;
        }) => void,
      ) {
        if (event !== "playbackStatusUpdate") return { remove() {} };
        return {
          remove: audio.store.subscribe(({ current, speed }) => {
            if (current && trackId(current.track) === id)
              listener({
                currentTime: current.position,
                playing: current.phase === "playing",
                playbackRate: speed,
              });
          }),
        };
      },
    }),
    [audio, id],
  );
  const failed = current?.phase === "error";
  const canSeek = props.ready && Boolean(current && !waiting && !failed);
  const control = waiting ? (
    <AttachmentProgress
      label={t("audio:cancel")}
      progress={props.progress}
      outgoing={props.outgoing}
      cancel={blocked ? undefined : press}
    />
  ) : props.checking ? (
    <AttachmentProgress label={t("audio:loading")} outgoing={props.outgoing} />
  ) : !props.ready || failed ? (
    <AttachmentAction
      icon={props.ready ? "refresh" : "download"}
      label={props.ready ? t("common:retry") : t("messages:voiceDownload")}
      onPress={press}
      disabled={blocked}
    />
  ) : undefined;

  return (
    <MessageAudio
      currentMessage={{ ...message, waveform: message.waveform ?? [] }}
      position={props.outgoing ? "right" : "left"}
      transcriptionControl={transcript?.control}
      controlledPlayback={{
        playing,
        currentTime: current?.position,
        duration: current?.duration || message.duration,
        disabled: blocked,
        onPress: press,
        label: t(playing ? "audio:pause" : "audio:play"),
        control,
        accessory: canSeek ? <SpeedControl compact /> : undefined,
        seek: canSeek && !blocked ? audio.seek : undefined,
        clock: canSeek ? (clock as PlaybackSource) : null,
      }}
    />
  );
}

function AudioFileRow({
  title,
  outgoing,
  control,
}: {
  title: string;
  outgoing: boolean;
  control: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.file, styles.row]}>
      {control}
      <Ink
        numberOfLines={2}
        style={[styles.title, outgoing && { color: colors.outgoingInk }]}
      >
        {title}
      </Ink>
    </View>
  );
}

export function AudioUploadAttachment({
  title,
  progress,
  retry,
}: {
  title: string;
  progress: number;
  retry?: () => void;
}) {
  const { t } = useTranslation(["audio", "common"]);
  return (
    <AudioFileRow
      title={title}
      outgoing
      control={
        retry ? (
          <AttachmentAction
            icon="refresh"
            label={t("common:retry")}
            onPress={retry}
          />
        ) : (
          <AttachmentProgress
            label={t("audio:loading")}
            outgoing
            progress={progress}
          />
        )
      }
    />
  );
}

export function AudioAttachment(props: TrackProps) {
  const { track, ready, checking, downloading, progress, outgoing } = props;
  const { colors } = useTheme();
  const { t } = useTranslation("audio");
  const { current, blocked, playing, waiting, press } =
    useAttachmentPlayback(props);
  const label = !ready ? t("download") : t(playing ? "pause" : "play");

  return (
    <AudioFileRow
      title={track.title}
      outgoing={outgoing}
      control={
        waiting || checking ? (
          <AttachmentProgress
            label={waiting && !blocked ? t("cancel") : t("loading")}
            progress={downloading ? progress : undefined}
            outgoing={outgoing}
            cancel={waiting && !blocked && !checking ? press : undefined}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={
              current?.phase === "error" ? t("unavailable") : undefined
            }
            disabled={blocked}
            onPress={press}
            style={[styles.play, { backgroundColor: colors.selected }]}
          >
            <Icon
              name={!ready ? "download" : playing ? "pause" : "play"}
              size={22}
            />
          </Pressable>
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  file: { width: 260, maxWidth: "100%", padding: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1 },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
