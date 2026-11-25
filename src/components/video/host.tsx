import { router, usePathname } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { useStore } from "zustand";
import { videoOrigin } from "@/core/video/types";
import { useLocal } from "@/services/local-context";
import { audioNavigationScene } from "@/components/audio/mini-player";
import { FloatingVideo } from "./viewer";
import { Captions } from "./captions";
import { selectedExternal } from "@/core/video/subtitles/tracks";

function VideoCoveredScene({ children }: { children: ReactNode }) {
  const { video } = useLocal();
  const covered = useStore(
    video.store,
    (state) => state.current?.presentation === "full",
  );
  return (
    <View
      collapsable={false}
      pointerEvents={covered ? "none" : "auto"}
      accessibilityElementsHidden={covered}
      importantForAccessibility={covered ? "no-hide-descendants" : "auto"}
      style={{ flex: 1 }}
    >
      {children}
    </View>
  );
}

export function videoNavigationScene(
  props: Parameters<typeof audioNavigationScene>[0],
) {
  return audioNavigationScene({
    ...props,
    children:
      props.route.name === "video-player" ? (
        props.children
      ) : (
        <VideoCoveredScene>{props.children}</VideoCoveredScene>
      ),
  });
}

export function VideoFrame({ children }: { children: ReactNode }) {
  const { video } = useLocal();
  const { current, preferences, captionAppearance } = useStore(video.store);
  const path = usePathname();
  const presentation = current?.presentation;
  const source = current?.source;
  const external =
    current?.subtitles.rendering === "fallback"
      ? selectedExternal(current.subtitles)
      : undefined;

  useEffect(() => {
    if (presentation !== "full" || path === "/video-player") return;
    const origin =
      source?.kind === "attachment" && source.source.kind === "marmot"
        ? videoOrigin(source.source.target)
        : undefined;
    router.push({
      pathname: "/video-player",
      params: origin ? { origin } : {},
    });
  }, [path, presentation, source]);

  return (
    <>
      {children}
      {current?.presentation === "floating" &&
        path !== "/video-player" &&
        current.player && (
          <FloatingVideo
            player={current.player}
            background={current.background}
            captions={
              external && (
                <Captions
                  player={current.player}
                  track={external}
                  offset={current.subtitles.offset}
                  appearance={captionAppearance}
                  controlsVisible
                  compact
                />
              )
            }
            allowPiP={current.allowPiP && preferences.pipMode === "system"}
            onPictureInPictureChange={(active) => {
              if (current.player)
                video.pictureInPicture(current.player, active);
            }}
            title={current.source.title}
            poster={
              current.source.thumbhash
                ? { thumbhash: current.source.thumbhash }
                : undefined
            }
            onClose={() => void video.close()}
            onExpand={() => video.present("full")}
          />
        )}
    </>
  );
}
