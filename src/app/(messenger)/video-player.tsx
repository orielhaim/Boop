import { useEffect, useSyncExternalStore } from "react";
import { Image } from "expo-image";
import { useNetworkState } from "expo-network";
import { router, useNavigation } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { VideoViewer } from "@/components/video/viewer";
import { Captions } from "@/components/video/captions";
import { SubtitleOptions } from "@/components/video/subtitle-options";
import { selectedExternal } from "@/core/video/subtitles/tracks";
import { useLocal } from "@/services/local-context";
import { useDialog } from "@/components/ui/dialog";
import { mediaId } from "@/core/media/source";
import { openDownloadedVideo } from "@/core/video/open";
import { formatBytes } from "@/i18n/format";
import { mediaMaterial } from "@/theme/tokens";
import { MediaControl, VideoGlass } from "@/components/video/media-controls";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function VideoPlayerRoute() {
  const dialog = useDialog();
  const { video, downloads } = useLocal();
  const { current, preferences, captionAppearance } = useStore(video.store);
  const navigation = useNavigation();
  const { t } = useTranslation("video");
  const presentation = current?.presentation;
  const sessionId = current?.id;
  const transferId = current?.progressive ? mediaId(current.source) : undefined;
  const completed = useSyncExternalStore(
    downloads.subscribe,
    () =>
      transferId !== undefined &&
      downloads.get(transferId)?.state === "completed" &&
      !downloads.get(transferId)?.intent,
  );
  const insets = useSafeAreaInsets();
  const retryTransfer = transferId
    ? () => {
        void openDownloadedVideo(transferId, {
          allowProgressive: true,
          replace: true,
        })
          .then((opened) => {
            if (!opened)
              return dialog.show({
                title: t("openFailed", { ns: "downloads" }),
                tone: "error",
              });
          })
          .catch(() =>
            dialog.show({
              title: t("openFailed", { ns: "downloads" }),
              tone: "error",
            }),
          );
      }
    : undefined;
  const transfer = transferId && (
    <TransferStatus id={transferId} onRetry={retryTransfer} />
  );

  useEffect(
    () => () => {
      const visible = video.store.getState().current;
      if (visible?.presentation === "full" && visible.id === sessionId)
        void video.close();
    },
    [video, sessionId],
  );

  useEffect(() => {
    if (presentation !== "full" && navigation.isFocused() && router.canGoBack())
      router.back();
  }, [navigation, presentation]);

  if (current?.presentation !== "full" || !current.player) {
    return (
      <View style={styles.waiting}>
        {!current?.suspended && current?.source.thumbhash && (
          <Image
            source={{ thumbhash: current.source.thumbhash }}
            cachePolicy="none"
            contentFit="contain"
            style={StyleSheet.absoluteFill}
          />
        )}
        {presentation === "full" && !current?.suspended && (
          <>
            <ActivityIndicator
              color={mediaMaterial.ink}
              accessibilityLabel={t("viewer.loading")}
            />
            <View
              style={[
                styles.close,
                {
                  top: insets.top + 8,
                  start: Math.max(insets.left, insets.right) + 12,
                },
              ]}
            >
              <MediaControl
                glass
                label={t("viewer.close")}
                icon="close"
                onPress={() => void video.close()}
              />
            </View>
            {transfer && (
              <View style={[styles.transfer, { bottom: insets.bottom + 12 }]}>
                {transfer}
              </View>
            )}
          </>
        )}
      </View>
    );
  }

  const {
    source,
    player,
    allowPiP,
    allowBackground,
    canExport,
    background,
    neighbors,
    subtitles,
  } = current;
  const origin =
    source.kind === "attachment" && source.source.kind === "marmot"
      ? source.source.target
      : undefined;
  const handoff = (action: "external" | "share" | "save") => {
    void video
      .exportFile(action)
      .catch(() =>
        dialog.show({ title: t("settings.openFailed"), tone: "error" }),
      );
  };
  const canImportSubtitles = canExport || current.progressive;
  const canHandoff = canExport || completed;
  const subtitleManagerAvailable =
    canImportSubtitles || subtitles.tracks.length > 0;
  return (
    <VideoViewer
      key={current.id}
      player={player}
      title={source.title}
      poster={source.thumbhash ? { thumbhash: source.thumbhash } : undefined}
      onClose={() => void video.close()}
      onMinimize={
        preferences.pipMode !== "off"
          ? () => video.present("floating")
          : undefined
      }
      onShare={canHandoff ? () => handoff("share") : undefined}
      onSave={canHandoff ? () => handoff("save") : undefined}
      onExternal={canHandoff ? () => handoff("external") : undefined}
      onOrigin={
        origin
          ? () => {
              void video.close();
              router.back();
              router.navigate({
                pathname: "/chat/[key]",
                params: {
                  key: `marmot-${origin[0]}`,
                  messageTarget: origin[1],
                },
              });
            }
          : undefined
      }
      onPictureInPictureChange={(active) =>
        video.pictureInPicture(player, active)
      }
      automaticPiP={preferences.pipMode === "system"}
      allowPiP={allowPiP && preferences.pipMode === "system"}
      background={background}
      allowBackground={allowBackground && preferences.allowBackground}
      onBackgroundChange={video.background}
      onMemoryWarning={video.onMemoryWarning}
      progressive={current.progressive}
      transfer={transfer}
      onRetry={retryTransfer}
      onPrevious={
        neighbors?.previous
          ? () => {
              void video.close();
              neighbors.previous?.();
            }
          : undefined
      }
      onNext={
        neighbors?.next
          ? () => {
              void video.close();
              neighbors.next?.();
            }
          : undefined
      }
      advancedGestures={preferences.advancedGestures}
      seekInterval={preferences.seekInterval}
      subtitleValue={
        subtitles.selection.kind === "external"
          ? selectedExternal(subtitles)?.name
          : subtitles.selection.kind === "embedded"
            ? subtitles.selection.track.label ||
              subtitles.selection.track.name ||
              subtitles.selection.track.language
            : undefined
      }
      canManageSubtitles={subtitleManagerAvailable}
      subtitleOptions={(tracks, screen) => (
        <SubtitleOptions
          screen={screen}
          state={subtitles}
          embedded={tracks}
          appearance={captionAppearance}
          canImport={canImportSubtitles}
          videoName={source.title ?? ""}
          importSignal={() => video.subtitleImportSignal(player)}
          select={(selection) => video.selectSubtitle(player, selection)}
          add={(inputs) => video.addSubtitles(player, inputs)}
          remove={(id) => video.removeSubtitle(player, id)}
          setEncoding={(id, encoding) =>
            video.subtitleEncoding(player, id, encoding)
          }
          setOffset={(offset) => video.subtitleOffset(player, offset)}
          setAppearance={(appearance) => video.captionAppearance(appearance)}
          onError={() =>
            void dialog.show({
              title: t("viewer.subtitleFailed"),
              tone: "error",
            })
          }
        />
      )}
      subtitleOverlay={
        subtitles
          ? (controlsVisible, bounds) => {
              const track = selectedExternal(subtitles);
              return track && subtitles.rendering === "fallback" ? (
                <Captions
                  player={player}
                  track={track}
                  appearance={captionAppearance}
                  offset={subtitles.offset}
                  controlsVisible={controlsVisible}
                  bounds={bounds}
                />
              ) : null;
            }
          : undefined
      }
    />
  );
}

function TransferStatus({ id, onRetry }: { id: string; onRetry?: () => void }) {
  const { downloads } = useLocal();
  const { t, i18n } = useTranslation("downloads");
  const { isConnected } = useNetworkState();
  const job = useSyncExternalStore(downloads.subscribe, () =>
    downloads.get(id),
  );
  if (!job || job.state === "completed") return null;
  const retry =
    job.state === "failed" ||
    job.state === "paused" ||
    job.state === "cancelled";
  const bytes = (value: number) => formatBytes(value, i18n.language);
  const status =
    isConnected === false && !retry
      ? "offline"
      : job.state === "active" && job.nativeState === "queued"
        ? "queued"
        : job.state;
  return (
    <VideoGlass elevation="none" style={styles.transferStatus}>
      <Text numberOfLines={2} style={styles.transferText}>
        {[
          t(status),
          job.total !== null
            ? t("bytesOf", {
                received: bytes(job.received),
                total: bytes(job.total),
              })
            : bytes(job.received),
          job.speed > 0 && isConnected !== false
            ? t("speed", { size: bytes(job.speed) })
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {retry && !job.intent && onRetry && (
        <MediaControl
          label={t(job.state === "paused" ? "resumeAndPlay" : "retryAndPlay")}
          icon={job.state === "paused" ? "play" : "refresh"}
          onPress={onRetry}
        />
      )}
    </VideoGlass>
  );
}

const styles = StyleSheet.create({
  waiting: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
  close: { position: "absolute" },
  transfer: { position: "absolute", alignSelf: "center", maxWidth: "85%" },
  transferStatus: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    minHeight: 34,
  },
  transferText: {
    color: mediaMaterial.ink,
    fontSize: 12,
    flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },
});
