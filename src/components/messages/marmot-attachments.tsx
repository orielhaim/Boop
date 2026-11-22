import { VoiceWaveform } from "@kesha-antonov/react-native-chat";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Image } from "expo-image";
import { shareAsync } from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState, StyleSheet, View } from "react-native";
import { Action, Ink } from "@/components/ui/kit";
import { marmot, type MarmotMessage } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

type Handoff = NonNullable<Awaited<ReturnType<typeof marmot.openAttachment>>>;
const time = (seconds: number) =>
  Math.floor(seconds / 60) +
  ":" +
  String(Math.floor(seconds % 60)).padStart(2, "0");

export function MarmotAttachments({
  group,
  row,
}: {
  group: string;
  row: MarmotMessage;
}) {
  if (!row.sourceId) return null;
  const source = row.sourceId;
  return (
    <View style={styles.stack}>
      {row.attachments.map((item) => (
        <Attachment
          key={item.index}
          group={group}
          row={row}
          item={item}
          source={source}
        />
      ))}
    </View>
  );
}

function Attachment({
  group,
  row,
  item,
  source,
}: {
  group: string;
  row: MarmotMessage;
  item: MarmotMessage["attachments"][number];
  source: string;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy, lock } = useLocal();
  const [local, setLocal] = useState(false);
  const [progress, setProgress] = useState<number | null>();
  const [handoff, setHandoff] = useState<Handoff>();
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void marmot
      .attachmentStatus(group, row.id, source, item.index)
      .then((ready) => {
        if (mounted.current) setLocal(ready);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, [group, row.id, source, item.index]);
  useEffect(() => {
    if (handoff)
      return () => {
        void marmot.releaseAttachment(handoff.lease).catch(() => undefined);
      };
  }, [handoff]);

  function allowed() {
    return (
      mounted.current &&
      !privacy.isBlocked(row.sender) &&
      !lock.getState().locked &&
      AppState.currentState === "active"
    );
  }

  async function open(download: boolean) {
    if (!allowed() || pending.current) return;
    pending.current = true;
    setProgress(null);
    let file: Handoff | null | undefined;
    try {
      file = await marmot.openAttachment(group, row.id, source, item.index);
      if (!file && !download) {
        setLocal(false);
        return;
      }
      if (!file && allowed()) {
        await marmot.downloadAttachment(
          group,
          row.id,
          source,
          item.index,
          (received, total) => {
            if (allowed())
              setProgress(
                total
                  ? Math.min(99, Math.floor((received / total) * 100))
                  : null,
              );
          },
        );
        if (allowed())
          file = await marmot.openAttachment(group, row.id, source, item.index);
      }
      if (!allowed()) return;
      if (!file) throw new Error("MediaUnavailable");
      setLocal(true);
      setHandoff(file);
      file = undefined;
    } catch {
      if (allowed()) Alert.alert(t("messages:mediaOpenFailed"));
    } finally {
      if (file)
        await marmot.releaseAttachment(file.lease).catch(() => undefined);
      pending.current = false;
      if (mounted.current) setProgress(undefined);
    }
  }

  const uri = handoff ? "file://" + handoff.path : undefined;
  const image = item.type.startsWith("image/");
  const video = item.type.startsWith("video/");
  const audio = item.type.startsWith("audio/");
  const round = video && (item.round || item.name === "video-note.mp4");
  const { colors } = useTheme();
  return (
    <View style={styles.stack}>
      {(image || video) && (item.thumbhash || (image && uri)) && (
        <Image
          accessibilityLabel={item.name}
          source={image ? uri : undefined}
          placeholder={
            item.thumbhash ? { thumbhash: item.thumbhash } : undefined
          }
          contentFit="contain"
          cachePolicy="memory"
          style={round ? styles.round : styles.visual}
        />
      )}
      <Ink kind="caption">{item.name}</Ink>
      {audio && item.waveform?.length && !uri ? (
        <VoiceWaveform waveform={item.waveform} color={colors.text} />
      ) : null}
      {item.duration || item.size != null ? (
        <Ink kind="caption">
          {item.duration
            ? time(item.duration)
            : new Intl.NumberFormat(undefined, {
                style: "unit",
                unit: "kilobyte",
                maximumFractionDigits: 1,
              }).format(item.size ? item.size / 1_024 : 0)}
        </Ink>
      ) : null}
      {uri && video && <Video uri={uri} round={round} />}
      {uri && audio && <Audio uri={uri} />}
      {handoff ? (
        <View style={styles.actions}>
          <Action
            size="sm"
            onPress={() => {
              if (allowed())
                void shareAsync("file://" + handoff.path, {
                  mimeType: handoff.type,
                }).catch(() => Alert.alert(t("messages:mediaOpenFailed")));
            }}
          >
            {t("messages:marmot.shareAttachment")}
          </Action>
          <Action size="sm" onPress={() => setHandoff(undefined)}>
            {t("common:close")}
          </Action>
        </View>
      ) : (
        <Action
          size="sm"
          disabled={progress !== undefined}
          onPress={() => void open(!local)}
        >
          {typeof progress === "number"
            ? progress + "%"
            : progress === null
              ? t("common:checking")
              : local
                ? t("messages:marmot.openAttachment")
                : t("messages:marmot.download")}
        </Action>
      )}
    </View>
  );
}

function Video({ uri, round }: { uri: string; round: boolean }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      style={round ? styles.round : styles.visual}
      player={player}
      nativeControls
    />
  );
}

function Audio({ uri }: { uri: string }) {
  const { t } = useTranslation(namespaces);
  const player = useAudioPlayer(uri);
  const { playing, currentTime, duration } = useAudioPlayerStatus(player);
  return (
    <View style={styles.actions}>
      <Action
        size="sm"
        onPress={() => {
          if (playing) player.pause();
          else {
            if (duration > 0 && currentTime >= duration) void player.seekTo(0);
            player.play();
          }
        }}
      >
        {t(
          playing
            ? "messages:marmot.pauseAttachment"
            : "messages:marmot.playAttachment",
        )}
      </Action>
      <Ink kind="caption">
        {time(currentTime)} / {time(duration)}
      </Ink>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs, padding: space.xs },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.xs,
    alignItems: "center",
  },
  visual: { width: 220, height: 144, borderRadius: 12, overflow: "hidden" },
  round: { width: 144, height: 144, borderRadius: 72, overflow: "hidden" },
});
