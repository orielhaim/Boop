import { useEffect } from "react";
import { Image } from "expo-image";
import { router, useNavigation } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useStore } from "zustand";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { VideoViewer } from "@/components/video/viewer";
import { Captions } from "@/components/video/captions";
import { SubtitleOptions } from "@/components/video/subtitle-options";
import { selectedExternal } from "@/core/video/subtitles/tracks";
import { useLocal } from "@/services/local-context";
import { useDialog } from "@/components/ui/dialog";

export default function VideoPlayerRoute() {
  const dialog = useDialog();
  const { video } = useLocal();
  const { current, preferences, captionAppearance } = useStore(video.store);
  const navigation = useNavigation();
  const { t } = useTranslation("video");
  const presentation = current?.presentation;
  const sessionId = current?.id;

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
          <ActivityIndicator
            color="#fff"
            accessibilityLabel={t("viewer.loading")}
          />
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
      onShare={canExport ? () => handoff("share") : undefined}
      onSave={canExport ? () => handoff("save") : undefined}
      onExternal={canExport ? () => handoff("external") : undefined}
      onOrigin={
        origin
          ? () => {
              void video.close();
              router.back();
              router.navigate({
                pathname: "/chat/[key]",
                params: { key: `marmot-${origin[0]}`, audioMessage: origin[1] },
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
      subtitleOptions={(tracks, close) => (
        <SubtitleOptions
          state={subtitles}
          embedded={tracks}
          appearance={captionAppearance}
          canImport={canExport}
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
          close={close}
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
          ? (controlsVisible) => {
              const track = selectedExternal(subtitles);
              return track && subtitles.rendering === "fallback" ? (
                <Captions
                  player={player}
                  track={track}
                  appearance={captionAppearance}
                  offset={subtitles.offset}
                  controlsVisible={controlsVisible}
                />
              ) : null;
            }
          : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  waiting: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
});
