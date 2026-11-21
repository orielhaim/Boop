import {
  MessageAudio,
  useMediaTransfer,
  VoiceWaveform,
} from "@kesha-antonov/react-native-chat";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Icon } from "@/components/ui/kit";
import { formatDuration } from "@/i18n/format";
import { useLocal } from "@/services/local";
import type { DetailMessage } from "./detail-adapter";

export const VoiceMessage = memo(function VoiceMessage({
  message,
  peer,
  enabled,
  color,
  rtl,
}: {
  message: DetailMessage;
  peer: string;
  enabled: boolean;
  color: string;
  rtl: boolean;
}) {
  const { attachments } = useLocal();
  const mediaTransfer = useMediaTransfer();
  const { t } = useTranslation("messages");
  const id = message._id;
  const getState = useCallback(
    () => attachments.downloadState(peer, id),
    [attachments, peer, id],
  );
  const subscribe = useCallback(
    (listener: () => void) => attachments.subscribe(listener, id),
    [attachments, id],
  );
  const state = useSyncExternalStore(subscribe, getState);
  const upload = useSyncExternalStore(subscribe, () =>
    attachments.uploadProgress(id),
  );
  const transferring =
    state === "downloading" ||
    state === "verifying" ||
    typeof state === "number";
  const [uri, setUri] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const playback = useRef<{ abort: AbortController; dispose?: () => void }>(
    undefined,
  );
  const available = enabled && state === "downloaded";
  useEffect(() => {
    if (!available) {
      setUri(undefined);
      setPreparing(false);
    }
    return () => {
      playback.current?.abort.abort();
      playback.current?.dispose?.();
      playback.current = undefined;
    };
  }, [available]);
  const samples = message.voice?.waveform;
  const bars = useMemo(
    () => samples?.map((sample) => sample / 100) ?? [],
    [samples],
  );
  const seconds =
    message.voice?.durationMs === undefined
      ? undefined
      : message.voice.durationMs / 1_000;
  const outgoing = message.direction === "outgoing";
  const releasePlayback = useCallback(() => {
    playback.current?.dispose?.();
    playback.current = undefined;
    setUri(undefined);
  }, []);
  if (available && uri) {
    return (
      <MessageAudio
        autoPlay
        onPlaybackEnded={releasePlayback}
        position={outgoing ? "right" : "left"}
        currentMessage={{
          ...message,
          audio: uri,
          isDownloadRequired: false,
          duration: seconds,
          waveform: bars,
          isMediaUnread: !outgoing && !message.voice?.listened,
        }}
      />
    );
  }

  function press() {
    if (transferring) {
      mediaTransfer.onCancel({ ...message, transfer: { type: "download" } });
      return;
    }
    if (!enabled || preparing) return;
    if (!available) {
      mediaTransfer.onDownload({ ...message, isDownloadRequired: true });
      return;
    }
    const lease: NonNullable<typeof playback.current> = {
      abort: new AbortController(),
    };
    playback.current = lease;
    setPreparing(true);
    setPlaybackError(false);
    void attachments
      .preparePlayback(peer, id, lease.abort.signal)
      .then((result) => {
        if (lease.abort.signal.aborted) {
          result.dispose();
          return;
        }
        lease.dispose = result.dispose;
        setUri(result.uri);
      })
      .catch(() => {
        if (!lease.abort.signal.aborted) setPlaybackError(true);
      })
      .finally(() => {
        if (!lease.abort.signal.aborted) setPreparing(false);
      });
  }

  const loading = preparing || transferring;
  const label = transferring
    ? t("voiceCancelDownload")
    : available
      ? t("voicePlay")
      : t("voiceDownload");
  const caption =
    message.failure === "media-paused"
      ? t("mediaUploadPaused")
      : typeof upload === "number"
        ? t("voiceUploadProgress", { percent: upload })
        : upload
          ? t(`voiceUpload_${upload}`)
          : playbackError
            ? t("voicePlaybackFailed")
            : state === "missing"
              ? t("voiceMissing")
              : state === "media-integrity" || state === "media-format"
                ? t("voiceValidationFailed")
                : state === "media-storage"
                  ? t("voiceStorageFailed")
                  : state === "cancelled"
                    ? t("voiceDownloadCancelled")
                    : state === "failed"
                      ? t("voiceDownloadFailed")
                      : typeof state === "number"
                        ? t("voiceDownloadProgress", { percent: state })
                        : seconds === undefined
                          ? t("voiceMessage")
                          : formatDuration(seconds);
  return (
    <View style={[styles.row, outgoing && styles.outgoing, rtl && styles.rtl]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={preparing || (!enabled && state !== "downloading")}
        onPress={press}
        accessibilityState={{ busy: loading, disabled: !enabled }}
        style={[styles.button, { borderColor: color }]}
      >
        {loading ? (
          <ActivityIndicator color={color} />
        ) : (
          <Icon
            name={available ? "play" : "download"}
            color={color}
            size={21}
          />
        )}
        {transferring && (
          <View style={styles.cancel} pointerEvents="none">
            <Icon name="hangup" color={color} size={11} />
          </View>
        )}
      </Pressable>
      <View style={styles.track}>
        <VoiceWaveform waveform={bars} color={color} />
        <Text numberOfLines={1} style={[styles.duration, { color }]}>
          {caption}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    width: 258,
    minHeight: 68,
  },
  outgoing: { width: 278 },
  rtl: { flexDirection: "row-reverse" },
  button: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
  },
  cancel: { position: "absolute" },
  track: { flex: 1 },
  duration: { fontSize: 12 },
});
