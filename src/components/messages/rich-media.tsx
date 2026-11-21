import {
  formatFileSize,
  type IMessage,
  MediaViewer,
  MediaViewerPage,
  MessageFile,
  MessageImage,
  MessageVideo,
  VideoTransferOverlay,
} from "@kesha-antonov/react-native-chat";
import { Image } from "expo-image";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
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
  useWindowDimensions,
} from "react-native";
import { Icon } from "@/components/ui/kit";
import { formatDuration } from "@/i18n/format";
import { useLocal } from "@/services/local";
import type { DetailMessage } from "./detail-adapter";

function useMediaState(peer: string, id: string) {
  const { attachments } = useLocal();
  const subscribe = useCallback(
    (run: () => void) => attachments.subscribe(run, id),
    [attachments, id],
  );
  const state = useSyncExternalStore(subscribe, () =>
    attachments.downloadState(peer, id),
  );
  const upload = useSyncExternalStore(subscribe, () =>
    attachments.uploadProgress(id),
  );
  return { attachments, state, upload };
}

function useLocalFile(peer: string, id: string, enabled: boolean) {
  const { attachments } = useLocal();
  const request = useMemo(() => ({ peer, id, enabled }), [peer, id, enabled]);
  const [result, setResult] = useState<
    | { request: typeof request; uri: string }
    | { request: typeof request; failed: true }
  >();
  useEffect(() => {
    if (!request.enabled) return;
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    void attachments
      .preparePlayback(request.peer, request.id, abort.signal)
      .then((file) => {
        if (abort.signal.aborted) file.dispose();
        else {
          dispose = file.dispose;
          setResult({ request, uri: file.uri });
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setResult({ request, failed: true });
      });
    return () => {
      abort.abort();
      dispose?.();
    };
  }, [attachments, request]);
  const current = result?.request === request ? result : undefined;
  return {
    uri: current && "uri" in current ? current.uri : undefined,
    failed: !!current && "failed" in current,
  };
}

type MediaDescription = NonNullable<DetailMessage["media"]>;
type MediaRow = DetailMessage & { media: MediaDescription };

function usePresentation(message: MediaRow, peer: string) {
  const { state, upload } = useMediaState(peer, message._id);
  const { media } = message;
  const { t } = useTranslation("messages");
  const downloading =
    state === "downloading" ||
    state === "verifying" ||
    typeof state === "number";
  const totalBytes = media.size;
  const transfer: IMessage["transfer"] = downloading
    ? {
        type: "download",
        progress: typeof state === "number" ? state / 100 : undefined,
        totalBytes,
      }
    : upload !== undefined
      ? {
          type: "upload",
          totalBytes,
          progress: typeof upload === "number" ? upload / 100 : undefined,
        }
      : undefined;
  const unavailable =
    state !== "downloaded" &&
    (!message.pending || message.direction === "incoming");
  const shown: IMessage = {
    ...message,
    isDownloadRequired: unavailable,
    transfer,
    duration:
      media.durationMs === undefined ? undefined : media.durationMs / 1000,
  };
  const notice =
    message.failure === "media-paused"
      ? t("mediaUploadPaused")
      : state === "verifying"
        ? t("mediaVerifying")
        : state === "missing"
          ? t("mediaMissing")
          : state === "media-integrity" || state === "media-format"
            ? t("mediaValidationFailed")
            : state === "media-storage"
              ? t("mediaStorageFailed")
              : state === "failed"
                ? t("voiceDownloadFailed")
                : undefined;
  return { ready: state === "downloaded", shown, notice };
}

function Poster({ media }: { media: MediaDescription }) {
  const placeholder = media.thumbhash
    ? { thumbhash: media.thumbhash }
    : media.blurhash
      ? { blurhash: media.blurhash }
      : undefined;
  return (
    <Image
      style={StyleSheet.absoluteFill}
      placeholder={placeholder}
      placeholderContentFit="cover"
      cachePolicy="none"
    />
  );
}

function Preview({
  message,
  shown,
  play,
  loading,
  height,
  width,
}: {
  message: MediaRow;
  shown: IMessage;
  play?: () => void;
  loading?: boolean;
  height: number;
  width: number;
}) {
  const { t } = useTranslation("messages");
  const round = message.media.kind === "round-video";
  const duration =
    shown.duration === undefined ? "" : formatDuration(shown.duration);
  const size =
    message.media.kind === "video" && message.media.size
      ? formatFileSize(message.media.size - 16)
      : "";
  const badge = [duration, size].filter(Boolean).join(" · ");
  return (
    <View
      style={[
        styles.poster,
        { width, height, borderRadius: round ? width / 2 : 12 },
      ]}
    >
      <Poster media={message.media} />
      {badge ? (
        <Text style={[styles.duration, round && styles.roundDuration]}>
          {badge}
        </Text>
      ) : null}
      {loading ? (
        <ActivityIndicator color="white" style={styles.center} />
      ) : null}
      {play ? (
        <Pressable
          style={styles.play}
          accessibilityRole="button"
          accessibilityLabel={t("mediaPlay")}
          onPress={play}
        >
          <Icon name="play" size={26} color="#fff" />
        </Pressable>
      ) : null}
      {shown.transfer || shown.isDownloadRequired ? (
        <VideoTransferOverlay
          message={shown}
          accessibilityLabel={
            shown.transfer
              ? t(
                  shown.transfer.type === "upload"
                    ? "mediaCancelUpload"
                    : "voiceCancelDownload",
                )
              : t("mediaDownload")
          }
        />
      ) : null}
    </View>
  );
}

function GalleryPage({
  page,
  message,
  peer,
  enabled,
}: {
  page: ComponentProps<typeof MediaViewerPage>;
  message: MediaRow;
  peer: string;
  enabled: boolean;
}) {
  const { t } = useTranslation("messages");
  const presentation = usePresentation(message, peer);
  const { uri, failed } = useLocalFile(
    peer,
    message._id,
    enabled && presentation.ready,
  );
  if (uri)
    return (
      <MediaViewerPage {...page} message={{ ...page.message, image: uri }} />
    );
  const width = Math.min(360, page.width - 32);
  return (
    <View
      style={{
        width: page.pageWidth,
        height: page.height,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Preview
        message={message}
        shown={presentation.shown}
        width={width}
        height={width}
        loading={presentation.ready && !failed}
      />
      {failed || presentation.notice ? (
        <Text style={styles.galleryNotice}>
          {failed ? t("mediaOpenFailed") : presentation.notice}
        </Text>
      ) : null}
    </View>
  );
}

export const RichMedia = memo(function RichMedia({
  message,
  peer,
  enabled,
  allowVideo,
  color,
  reducedMotion,
  galleryItems,
  onFile,
}: {
  message: MediaRow;
  peer: string;
  enabled: boolean;
  allowVideo: boolean;
  color: string;
  reducedMotion: boolean;
  galleryItems: () => readonly DetailMessage[];
  onFile: (message: MediaRow) => void;
}) {
  const { t } = useTranslation("messages");
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const { ready, shown, notice } = usePresentation(message, peer);
  const { media } = message;
  const [gallery, setGallery] = useState<MediaRow[]>();
  const [play, setPlay] = useState(false);
  const video = media.kind === "video" || media.kind === "round-video";
  const image = media.kind === "image";
  if (!enabled && gallery) setGallery(undefined);
  if ((!allowVideo || !ready) && play) setPlay(false);
  const { uri, failed } = useLocalFile(
    peer,
    message._id,
    enabled && ready && (image || (video && play && allowVideo)),
  );
  const round = media.kind === "round-video";
  const maxWidth = Math.min(260, screenWidth * 0.66);
  const circle = Math.min(screenWidth, screenHeight) * 0.54;
  const aspect = media.dimensions
    ? media.dimensions.width / media.dimensions.height
    : video
      ? 16 / 9
      : 4 / 3;
  const width = round ? circle : Math.max(84, Math.min(maxWidth, 260 * aspect));
  const height = round ? circle : Math.max(84, Math.min(260, width / aspect));
  const error = failed ? t("mediaOpenFailed") : notice;
  const position = message.direction === "incoming" ? "left" : "right";

  function openGallery() {
    const photos = galleryItems().flatMap((item) =>
      item.media?.kind === "image" ? [{ ...item, media: item.media }] : [],
    );
    setGallery(photos.reverse());
  }

  return (
    <View style={styles.wrapper}>
      {media.kind === "file" ? (
        <MessageFile
          currentMessage={{
            ...shown,
            file: {
              name: media.filename ?? t("mediaFile"),
              mimeType: media.mime,
              size: media.size === undefined ? undefined : media.size - 16,
            },
          }}
          position={position}
          accessibilityHint={
            shown.transfer
              ? t(
                  shown.transfer.type === "upload"
                    ? "mediaCancelUpload"
                    : "voiceCancelDownload",
                )
              : t(ready ? "mediaOpen" : "mediaDownload")
          }
          onPress={() => {
            if (ready && enabled) onFile(message);
          }}
        />
      ) : image && uri ? (
        <MessageImage
          currentMessage={{ ...shown, image: uri }}
          containerStyle={{ width, height }}
          imageStyle={{ width, minWidth: width, height }}
          imageProps={{
            fadeDuration: reducedMotion ? 0 : 150,
            resizeMode: "contain",
          }}
          onOpen={openGallery}
        />
      ) : video && uri ? (
        <MessageVideo
          autoPlay
          currentMessage={{ ...shown, video: uri, videoNote: round }}
          position={position}
          videoStyle={round ? undefined : { width, height }}
          videoProps={{ allowsPictureInPicture: false }}
        />
      ) : (
        <Preview
          message={message}
          shown={shown}
          width={width}
          height={height}
          play={
            video && ready && allowVideo && !play
              ? () => setPlay(true)
              : undefined
          }
          loading={ready && (image || (video && play)) && !failed}
        />
      )}
      {error ? <Text style={[styles.error, { color }]}>{error}</Text> : null}
      {gallery && enabled ? (
        <MediaViewer
          items={gallery}
          initialIndex={Math.max(
            0,
            gallery.findIndex((photo) => photo._id === message._id),
          )}
          onClose={() => setGallery(undefined)}
          renderPage={(page) => {
            const photo = gallery[page.index];
            return photo ? (
              <GalleryPage
                page={page}
                message={photo}
                peer={peer}
                enabled={enabled}
              />
            ) : null;
          }}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { margin: 4 },
  poster: {
    backgroundColor: "#353c4a",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  center: { position: "absolute", alignSelf: "center" },
  play: {
    backgroundColor: "#111b",
    borderRadius: 26,
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  duration: {
    position: "absolute",
    right: 8,
    bottom: 8,
    color: "#fff",
    backgroundColor: "#111b",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    fontVariant: ["tabular-nums"],
  },
  roundDuration: { right: undefined, alignSelf: "center", bottom: 14 },
  error: { fontSize: 12, margin: 4, maxWidth: 250 },
  galleryNotice: { color: "#fff", textAlign: "center", margin: 12 },
});
