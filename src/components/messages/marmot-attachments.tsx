import { acceptedAttachments } from "@/core/marmot/message-projection";
import {
  AudioAttachment,
  VoiceMessageAttachment,
} from "@/components/audio/attachment";
import { audioFile, type Track } from "@/core/audio/types";
import type { MarmotDownload } from "@/core/downloads/types";
import {
  localMediaUri as localUri,
  openLocalAttachment,
} from "@/core/media/open-local-attachment";
import {
  type IMessage,
  MediaViewer,
  MediaViewerPage,
  MessageFile,
  MessageImage,
  VideoTransferOverlay,
} from "@kesha-antonov/react-native-chat";
import { Directory, File } from "expo-file-system";
import { Image } from "expo-image";
import { saveToLibraryAsync } from "expo-media-library/legacy";
import { shareAsync } from "expo-sharing";
import { VideoView, type VideoPlayer } from "expo-video";
import { useEvent } from "expo";
import Transition from "react-native-screen-transitions";
import { useStore } from "zustand";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ActivityIndicator,
  View,
  useWindowDimensions,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon, Ink } from "@/components/ui/kit";
import {
  attachmentKey,
  type AttachmentPresentation,
  type AttachmentTarget,
} from "@/core/marmot/attachment-presentation";
import type { MarmotMessage } from "@/core/marmot/native";
import { speechSource } from "@/core/speech/service";
import type { SpeechSource } from "@/core/speech/types";
import { formatBytes, formatDuration } from "@/i18n/format";
import { mediaId } from "@/core/media/source";
import { videoFile, videoOrigin } from "@/core/video/types";
import type { VideoNeighbors } from "@/core/video/controller";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { useVoiceTranscript } from "./voice-transcript";

type Item = ReturnType<typeof acceptedAttachments>[number];
type Asset = { target: AttachmentTarget; item: Item; speech?: SpeechSource };
type AttachmentProps = {
  asset: Asset;
  message: IMessage;
  presentation: AttachmentPresentation;
};
type GalleryItem = { asset: Asset; message: IMessage };

export function audioTrackForMessage(
  source: MarmotDownload,
  item: Item,
  message: IMessage,
  conversation: string,
  voiceLabel: string,
): Track {
  const sender =
    message.user.name !== String(message.user._id)
      ? message.user.name
      : undefined;
  return {
    kind: "attachment",
    source,
    title: item.voice ? sender || voiceLabel : item.name,
    subtitle: item.voice ? conversation : sender,
    voice: item.voice === true,
    duration: item.duration ?? undefined,
  };
}

export function conversationMedia(
  group: string,
  messages: readonly (IMessage & { row?: MarmotMessage })[],
) {
  const items: GalleryItem[] = [];
  for (const message of [...messages].reverse()) {
    const row = message.row;
    if (
      !row?.sourceId ||
      row.deleted ||
      row.invalidationStatus ||
      message.isViewOnce
    )
      continue;
    for (const item of acceptedAttachments(row)) {
      if (photo(item) || (!item.round && videoFile(item.name, item.type)))
        items.push({
          asset: { item, target: [group, row.id, row.sourceId, item.index] },
          message,
        });
    }
  }
  return items;
}

function useAttachment({ asset, message, presentation }: AttachmentProps) {
  const { target, item } = asset;
  const [group, id, source, index] = target;
  const key = attachmentKey(target);
  const subscribe = useCallback(
    (notify: () => void) =>
      presentation.subscribe([group, id, source, index], notify),
    [group, id, index, presentation, source],
  );
  const state = useSyncExternalStore(subscribe, () => presentation.state(key));
  const uri = state.kind === "local" ? localUri(state.lease.path) : undefined;
  const shown: IMessage = {
    _id: key,
    createdAt: message.createdAt,
    user: message.user,
    text: message.text,
    duration: item.duration ?? undefined,
    isMediaUnread: message.isMediaUnread,
    waveform: item.waveform?.map((level) => level / 31),
    isDownloadRequired:
      state.kind === "remote" ||
      state.kind === "failed" ||
      state.kind === "cancelled" ||
      state.kind === "paused",
    transfer:
      state.kind === "downloading"
        ? {
            type: "download",
            progress: state.progress,
            totalBytes: item.size ?? undefined,
          }
        : undefined,
  };
  return { key, state, uri, shown };
}

function posterSize(item: Item, max: number) {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(item.dimensions ?? "");
  const ratio = match ? Number(match[1]) / Number(match[2]) : 4 / 3;
  return Math.max(100, Math.min(max * 1.2, max / (ratio || 1)));
}

function Poster({ item }: { item: Item }) {
  return (
    <Image
      accessibilityLabel={item.name}
      style={StyleSheet.absoluteFill}
      placeholder={item.thumbhash ? { thumbhash: item.thumbhash } : undefined}
      placeholderContentFit="cover"
      cachePolicy="none"
    />
  );
}

export function MarmotAttachments({
  group,
  conversation,
  row,
  message,
  presentation,
  gallery,
  foreground,
  visible,
}: {
  group: string;
  conversation: string;
  row: MarmotMessage;
  message: IMessage;
  presentation: AttachmentPresentation;
  gallery: GalleryItem[];
  foreground: boolean;
  visible: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const { reduceMotion } = useTheme();
  const { identity } = useLocal();
  const { t } = useTranslation("messages");
  const assets = useMemo(() => {
    const source = row.sourceId;
    const indexed = new Map<number, Asset>();
    if (!source) return indexed;
    for (const item of acceptedAttachments(row)) {
      indexed.set(item.index, {
        item,
        target: [group, row.id, source, item.index],
        speech: message.isViewOnce
          ? undefined
          : speechSource(group, row, item, identity.publicKey),
      });
    }
    return indexed;
  }, [group, identity.publicKey, message.isViewOnce, row]);
  const galleryIndex = gallery.findIndex(
    ({ asset }) => attachmentKey(asset.target) === selected,
  );

  function neighbors(index: number): VideoNeighbors | undefined {
    if (index < 0) return;
    const previous = gallery[index - 1];
    const next = gallery[index + 1];
    return {
      previous:
        previous && (() => setSelected(attachmentKey(previous.asset.target))),
      next: next && (() => setSelected(attachmentKey(next.asset.target))),
    };
  }
  return (
    <View style={styles.stack}>
      {row.attachments.map((item) => {
        if (item.outcome === "rejected")
          return (
            <Ink key={item.index}>{t("marmot.mediaReferenceUnavailable")}</Ink>
          );
        const asset = assets.get(item.index);
        return (
          asset && (
            <Attachment
              key={asset.item.index}
              asset={asset}
              message={message}
              conversation={conversation}
              presentation={presentation}
              foreground={foreground}
              visible={visible}
              openPhoto={() => setSelected(attachmentKey(asset.target))}
              neighbors={neighbors(
                gallery.findIndex(
                  (entry) =>
                    attachmentKey(entry.asset.target) ===
                    attachmentKey(asset.target),
                ),
              )}
            />
          )
        );
      })}
      {galleryIndex >= 0 && (
        <Modal
          animationType={reduceMotion ? "none" : "fade"}
          visible
          onRequestClose={() => setSelected(undefined)}
        >
          <MediaViewer
            items={gallery.map(({ asset, message: item }) => ({
              _id: attachmentKey(asset.target),
              user: item.user,
              text: item.text,
              createdAt: item.createdAt,
            }))}
            initialIndex={galleryIndex}
            onClose={() => setSelected(undefined)}
            renderPage={(props) => {
              const asset = gallery[props.index]?.asset;
              return (
                asset && (
                  <GalleryPage
                    {...props}
                    asset={asset}
                    presentation={presentation}
                    foreground={foreground}
                    onPlay={() => setSelected(undefined)}
                    neighbors={neighbors(props.index)}
                  />
                )
              );
            }}
          />
        </Modal>
      )}
    </View>
  );
}

function photo(item: Item) {
  return item.type.startsWith("image/");
}

export async function exportMarmotAttachment(
  presentation: AttachmentPresentation,
  target: AttachmentTarget,
  item: Item,
  action: "save" | "share",
) {
  await presentation.useLocalFile(target, async (file) => {
    const source = new File(localUri(file.path));
    if (action === "save" && (photo(item) || item.type.startsWith("video/"))) {
      await saveToLibraryAsync(source.uri);
    } else if (action === "save" && Platform.OS === "android") {
      const location = await Directory.pickDirectoryAsync();
      if (location) await source.copy(location);
    } else {
      await shareAsync(source.uri, {
        mimeType: file.type,
        dialogTitle: item.name,
      });
    }
  });
}

function GalleryPage({
  asset,
  presentation,
  foreground,
  onPlay,
  neighbors,
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  asset: Asset;
  presentation: AttachmentPresentation;
  foreground: boolean;
  onPlay(): void;
  neighbors?: VideoNeighbors;
}) {
  const { key, state, uri, shown } = useAttachment({
    asset,
    presentation,
    message: page.message,
  });
  useEffect(() => {
    if (foreground && photo(asset.item) && state.kind === "cached")
      presentation.prepare(key);
  }, [asset.item, foreground, key, presentation, state.kind]);
  if (videoFile(asset.item.name, asset.item.type))
    return (
      <VideoAttachment
        asset={asset}
        message={page.message}
        presentation={presentation}
        frame={{ width: page.width, height: page.height, borderRadius: 0 }}
        onOpen={onPlay}
        neighbors={neighbors}
      />
    );
  if (uri)
    return <MediaViewerPage {...page} message={{ ...shown, image: uri }} />;
  return (
    <View
      style={[styles.placeholder, { width: page.width, height: page.height }]}
    >
      <Poster item={asset.item} />
      <VideoTransferOverlay message={shown} />
    </View>
  );
}

function Attachment({
  openPhoto,
  neighbors,
  conversation,
  foreground,
  visible,
  ...props
}: AttachmentProps & {
  openPhoto: () => void;
  neighbors?: VideoNeighbors;
  conversation: string;
  foreground: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation("messages");
  const {
    asset: { item, target, speech: source },
    presentation,
  } = props;
  const { state, key, uri, shown } = useAttachment(props);
  const { identity } = useLocal();
  const transcript = useVoiceTranscript(
    source,
    state.kind === "cached" || state.kind === "local",
    visible,
  );
  const { width, height } = useWindowDimensions();
  const position =
    props.message.user._id === identity.publicKey ? "right" : "left";
  const isPhoto = photo(item);
  const video = videoFile(item.name, item.type);
  const audio = audioFile(item.name, item.type);
  const round = video && item.round === true;
  const visualWidth = round
    ? Math.min(width, height) * 0.54
    : Math.min(width * 0.67, 300);
  const dimensions = /^(\d{1,5})x(\d{1,5})$/u.exec(item.dimensions ?? "");
  const ratio = dimensions ? Number(dimensions[1]) / Number(dimensions[2]) : 0;
  const videoWidth =
    ratio > 0 && Number.isFinite(ratio)
      ? Math.min(visualWidth, Math.min(height * 0.5, 380) * ratio)
      : visualWidth;
  const frame = {
    width: video && !round ? videoWidth : visualWidth,
    height: round
      ? visualWidth
      : video && ratio > 0 && Number.isFinite(ratio)
        ? videoWidth / ratio
        : posterSize(item, visualWidth),
    borderRadius: round ? visualWidth / 2 : 16,
  };
  useEffect(() => {
    if (foreground && state.kind === "cached" && isPhoto)
      presentation.prepare(key);
  }, [foreground, isPhoto, key, presentation, state.kind]);
  const progress = state.kind === "downloading";
  const notice =
    state.kind === "failed"
      ? t("voiceDownloadFailed")
      : state.kind === "cancelled"
        ? t("voiceDownloadCancelled")
        : progress && state.verifying
          ? t("mediaVerifying")
          : undefined;

  let body;
  if (isPhoto && uri) {
    body = (
      <MessageImage
        currentMessage={{ ...shown, image: uri }}
        imageStyle={frame}
        onOpen={openPhoto}
      />
    );
  } else if (video) {
    if (props.message.isViewOnce) return null;
    body = <VideoAttachment {...props} frame={frame} neighbors={neighbors} />;
  } else if (isPhoto) {
    body = (
      <View style={[styles.placeholder, frame]}>
        <Poster item={item} />
        <VideoTransferOverlay message={shown} />
        {item.duration != null && (
          <Ink kind="caption" style={styles.duration}>
            {formatDuration(item.duration)}
          </Ink>
        )}
      </View>
    );
  } else if (audio) {
    const source = presentation.sourceFor(target);
    if (!source || props.message.isViewOnce) return null;
    const player = {
      track: audioTrackForMessage(
        source,
        item,
        props.message,
        conversation,
        t("voiceMessage"),
      ),
      ready: state.kind === "cached" || state.kind === "local",
      checking: state.kind === "checking",
      downloading: state.kind === "downloading",
      progress: shown.transfer?.progress,
      outgoing: position === "right",
      authorize: () => Boolean(presentation.authorize(target)),
    };
    body = item.voice ? (
      <VoiceMessageAttachment
        {...player}
        message={shown}
        transcript={transcript}
      />
    ) : (
      <AudioAttachment {...player} />
    );
  } else {
    body = (
      <MessageFile
        currentMessage={{
          ...shown,
          file: {
            uri,
            name: item.name,
            size: item.size ?? undefined,
            mimeType: item.type,
          },
        }}
        position={position}
        onPress={() =>
          void presentation
            .useLocalFile(target, openLocalAttachment)
            .catch(() => Alert.alert(t("mediaOpenFailed")))
        }
      />
    );
  }

  return (
    <View style={styles.item}>
      {body}
      {notice && <Ink kind="caption">{notice}</Ink>}
    </View>
  );
}

function VideoAttachment({
  asset,
  message,
  presentation,
  frame,
  onOpen,
  neighbors,
}: AttachmentProps & {
  frame: { width: number; height: number; borderRadius: number };
  onOpen?: () => void;
  neighbors?: VideoNeighbors;
}) {
  const { video } = useLocal();
  const { t, i18n } = useTranslation(["video", "messages", "audio"]);
  const { reduceMotion } = useTheme();
  const { item, target } = asset;
  const { key, state, shown } = useAttachment({ asset, message, presentation });
  const inline = useStore(video.store, ({ current }) =>
    current?.presentation === "inline" && mediaId(current.source) === key
      ? current.player
      : undefined,
  );
  const [opening, setOpening] = useState(false);
  const ready = state.kind === "cached" || state.kind === "local";
  const busy =
    opening || state.kind === "checking" || state.kind === "preparing";
  const transfer = state.kind === "downloading";
  const label = ready ? t("video:viewer.play") : t("audio:download");

  const play = async () => {
    const source = presentation.authorize(target);
    if (!source || busy) return;
    setOpening(true);
    if (ready) onOpen?.();
    try {
      const opened = await video.open(
        {
          kind: "attachment",
          source,
          title: item.name,
          round: item.round,
          duration: item.duration,
          dimensions: item.dimensions,
          thumbhash: item.thumbhash,
        },
        { download: !ready, neighbors },
      );
      if (!opened && presentation.authorize(target) && !transfer && ready)
        Alert.alert(t("video:settings.openFailed"));
      else if (opened && !ready) onOpen?.();
    } finally {
      setOpening(false);
    }
  };
  return (
    <Transition.Boundary
      id={videoOrigin(target)}
      enabled={!item.round && !reduceMotion && !onOpen}
      style={[styles.placeholder, frame]}
    >
      {inline ? (
        <InlineVideo player={inline} item={item} />
      ) : (
        <>
          <Poster item={item} />
          {transfer ? (
            <VideoTransferOverlay message={shown} />
          ) : (
            <Pressable
              style={styles.videoAction}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={() => void play()}
            >
              <View style={styles.videoBadge}>
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Icon
                    name={
                      ready
                        ? "play"
                        : state.kind === "failed"
                          ? "refresh"
                          : "download"
                    }
                    size={24}
                    color="#fff"
                  />
                )}
              </View>
            </Pressable>
          )}
        </>
      )}
      {(item.duration != null ||
        (item.size != null && !ready && !item.round)) && (
        <Ink kind="caption" style={styles.duration}>
          {[
            item.duration == null ? undefined : formatDuration(item.duration),
            item.size == null || ready || item.round
              ? undefined
              : formatBytes(item.size, i18n.language),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Ink>
      )}
    </Transition.Boundary>
  );
}

function InlineVideo({ player, item }: { player: VideoPlayer; item: Item }) {
  const { video } = useLocal();
  useEffect(
    () => () => {
      if (video.store.getState().current?.player === player) void video.close();
    },
    [player, video],
  );
  const [firstFrame, setFirstFrame] = useState(false);
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    bufferedPosition: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const { t } = useTranslation("video");
  return (
    <>
      <VideoView
        player={player}
        nativeControls={false}
        surfaceType="textureView"
        contentFit="cover"
        style={StyleSheet.absoluteFill}
        onFirstFrameRender={() => setFirstFrame(true)}
      />
      {!firstFrame && <Poster item={item} />}
      <Pressable
        style={styles.videoAction}
        accessibilityRole="button"
        accessibilityLabel={t(isPlaying ? "viewer.pause" : "viewer.play")}
        onPress={() => {
          if (isPlaying) player.pause();
          else if (player.currentTime >= player.duration) player.replay();
          else player.play();
        }}
      >
        {!isPlaying && (
          <View style={styles.videoBadge}>
            <Icon name="play" size={24} color="#fff" />
          </View>
        )}
      </Pressable>
      {firstFrame && player.duration > 0 && (
        <View pointerEvents="none" style={styles.inlineTrack}>
          <View
            style={[
              styles.inlineProgress,
              {
                width: `${Math.min(100, (100 * currentTime) / player.duration)}%`,
              },
            ]}
          />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs, padding: space.xs },
  item: { gap: space.xs },
  placeholder: { backgroundColor: "#333438", overflow: "hidden" },
  videoAction: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  videoBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0009",
  },
  inlineTrack: {
    position: "absolute",
    start: "17%",
    end: "17%",
    bottom: 20,
    height: 3,
    backgroundColor: "#fff5",
    borderRadius: 2,
    overflow: "hidden",
  },
  inlineProgress: { height: 3, backgroundColor: "#fff" },
  duration: {
    position: "absolute",
    bottom: 8,
    end: 8,
    color: "#fff",
    backgroundColor: "#0009",
    borderRadius: 8,
    paddingHorizontal: 5,
  },
});
