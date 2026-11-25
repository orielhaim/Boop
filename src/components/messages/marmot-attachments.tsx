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
  MessageVideo,
  type MessageVideoProps,
  useTheme as useChatKitTheme,
  VideoTransferOverlay,
} from "@kesha-antonov/react-native-chat";
import { Directory, File } from "expo-file-system";
import { Image, type ImageRef } from "expo-image";
import { BlurTargetView, BlurView } from "expo-blur";
import { saveToLibraryAsync } from "expo-media-library/legacy";
import { shareAsync } from "expo-sharing";
import Transition from "react-native-screen-transitions";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";
import { Modal, Platform, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon, Ink } from "@/components/ui/kit";
import { useGlassTheme } from "@/components/glassyui/glass-provider";
import { useGlassBackdropTarget } from "@/components/glassyui/lib/glass-backdrop";
import {
  attachmentKey,
  type AttachmentPresentation,
  type AttachmentTarget,
} from "@/core/marmot/attachment-presentation";
import type {
  MarmotMessage,
  MarmotUpload,
  SharedMediaRow,
} from "@/core/marmot/native";
import { speechSource } from "@/core/speech/service";
import type { SpeechSource } from "@/core/speech/types";
import { formatDuration } from "@/i18n/format";
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
type RoundNotePlayback = NonNullable<
  MessageVideoProps<IMessage>["roundNotePlayback"]
>;

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

function useAttachment({
  asset,
  message,
  presentation,
}: Omit<AttachmentProps, "asset"> & { asset?: Asset }) {
  const [group, id, source, index] = asset?.target ?? [];
  const item = asset?.item;
  const key = asset ? attachmentKey(asset.target) : "";
  const subscribe = useCallback(
    (notify: () => void) =>
      group !== undefined &&
      id !== undefined &&
      source !== undefined &&
      index !== undefined
        ? presentation.subscribe([group, id, source, index], notify)
        : () => undefined,
    [group, id, index, presentation, source],
  );
  const state = useSyncExternalStore(subscribe, () => presentation.state(key));
  const uri = state.kind === "local" ? localUri(state.lease.path) : undefined;
  const shown: IMessage = {
    _id: key || message._id,
    rowKey: message.rowKey,
    createdAt: message.createdAt,
    user: message.user,
    text: message.text,
    duration: item?.duration ?? undefined,
    videoNote: item?.round || undefined,
    isMediaUnread: message.isMediaUnread,
    waveform: item?.waveform?.map((level) => level / 31),
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
            totalBytes: item?.size ?? undefined,
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

function attachmentNotice(state: ReturnType<typeof useAttachment>["state"]) {
  if (state.kind === "failed") return "voiceDownloadFailed";
  if (state.kind === "cancelled") return "voiceDownloadCancelled";
  if (state.kind === "downloading" && state.verifying) return "mediaVerifying";
}
function Poster({
  item,
  source,
  timestampBackdrop,
}: {
  item: Pick<Item, "name" | "thumbhash">;
  source?: ImageRef;
  timestampBackdrop?: boolean;
}) {
  const target = useGlassBackdropTarget();
  const { preferences } = useGlassTheme();
  const poster = (
    <Image
      accessibilityLabel={item.name}
      style={StyleSheet.absoluteFill}
      source={source}
      contentFit="cover"
      placeholder={
        !source && item.thumbhash ? { thumbhash: item.thumbhash } : undefined
      }
      placeholderContentFit="cover"
      cachePolicy="none"
    />
  );
  return timestampBackdrop && target && !preferences.reduceTransparency ? (
    <BlurTargetView ref={target} style={StyleSheet.absoluteFill}>
      {poster}
    </BlurTargetView>
  ) : (
    poster
  );
}

export function VideoTimestampBackground() {
  const target = useGlassBackdropTarget();
  const { preferences } = useGlassTheme();
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {!preferences.reduceTransparency && (
        <BlurView
          style={StyleSheet.absoluteFill}
          intensity={18}
          tint="dark"
          blurTarget={
            Platform.OS === "android" ? (target ?? undefined) : undefined
          }
          blurMethod={
            Platform.OS === "android" && target
              ? "dimezisBlurViewSdk31Plus"
              : undefined
          }
        />
      )}
      <View
        style={[
          StyleSheet.absoluteFill,
          preferences.reduceTransparency
            ? styles.opaqueTimestamp
            : styles.timestampTint,
        ]}
      />
    </View>
  );
}

function useVideoFrame(dimensions?: string | null) {
  const { width, height } = useWindowDimensions();
  const theme = useChatKitTheme();
  const match = /^(\d{1,5})x(\d{1,5})$/u.exec(dimensions ?? "");
  const ratio = match ? Number(match[1]) / Number(match[2]) : 0;
  const hasRatio = ratio > 0 && Number.isFinite(ratio);
  const visualWidth = hasRatio
    ? Math.min(width * 0.67, 300, Math.min(height * 0.5, 380) * ratio)
    : Math.min(width * 0.67, 220);
  return {
    width: visualWidth,
    height: hasRatio ? visualWidth / ratio : 140,
    borderRadius: theme.radii.bubble,
    margin: 0,
  };
}

export type PendingVideoFile = {
  file: Omit<MarmotUpload, "path">;
  poster?: ImageRef;
};

export type VideoUpload = {
  id: string;
  files: readonly PendingVideoFile[];
  progress?: number;
  retry?: () => void;
};

export function MarmotAttachments({
  group,
  conversation,
  row,
  upload,
  message,
  presentation,
  gallery,
  foreground,
  visible,
  timestampBackdrop,
}: {
  group: string;
  conversation: string;
  row?: MarmotMessage;
  upload?: VideoUpload;
  message: IMessage;
  presentation: AttachmentPresentation;
  gallery: GalleryItem[];
  foreground: boolean;
  visible: boolean;
  timestampBackdrop: boolean;
}) {
  const [selected, setSelected] = useState<string>();
  const dialog = useDialog();
  const { reduceMotion } = useTheme();
  const { identity } = useLocal();
  const { t } = useTranslation("messages");
  const assets = useMemo(() => {
    const source = row?.sourceId;
    const indexed = new Map<number, Asset>();
    if (!row || !source) return indexed;
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
  const pending = !row?.sourceId ? upload : undefined;
  const entries = pending
    ? pending.files.map((_, index) => ({ index, outcome: "accepted" as const }))
    : (row?.attachments ?? []);

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
    <View
      style={
        entries.length === 1 &&
        (message.videoNote ||
          Array.from(assets.values()).some(({ item }) =>
            videoFile(item.name, item.type),
          ) ||
          pending?.files.some(({ file }) => videoFile(file.name, file.type)))
          ? undefined
          : styles.stack
      }
    >
      {entries.map((item) => {
        if (item.outcome === "rejected")
          return (
            <Ink key={item.index}>{t("marmot.mediaReferenceUnavailable")}</Ink>
          );
        const asset = assets.get(item.index);
        const preview = upload?.files[item.index];
        const metadata = asset?.item ?? (pending ? preview?.file : undefined);
        if (metadata && videoFile(metadata.name, metadata.type)) {
          if (message.isViewOnce) return null;
          return (
            <VideoAttachment
              key={item.index}
              asset={asset}
              message={message}
              dialog={dialog}
              metadata={metadata}
              presentation={presentation}
              poster={preview?.poster}
              upload={pending}
              position={
                message.user._id === identity.publicKey ? "right" : "left"
              }
              foreground={foreground}
              timestampBackdrop={timestampBackdrop}
              neighbors={
                asset &&
                neighbors(
                  gallery.findIndex(
                    (entry) =>
                      attachmentKey(entry.asset.target) ===
                      attachmentKey(asset.target),
                  ),
                )
              }
            />
          );
        }
        if (!asset && preview && pending)
          return (
            <MessageFile
              key={item.index}
              currentMessage={{
                ...message,
                _id: pending.id,
                transfer:
                  pending.progress === undefined
                    ? undefined
                    : { type: "upload", progress: pending.progress },
                file: { name: preview.file.name, mimeType: preview.file.type },
              }}
              position="right"
            />
          );
        return (
          asset && (
            <Attachment
              key={asset.item.index}
              dialog={dialog}
              asset={asset}
              message={message}
              conversation={conversation}
              presentation={presentation}
              foreground={foreground}
              visible={visible}
              openPhoto={() => setSelected(attachmentKey(asset.target))}
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
                    dialog={dialog}
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
  dialog,
  presentation,
  foreground,
  onPlay,
  neighbors,
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  asset: Asset;
  dialog: ReturnType<typeof useDialog>;
  presentation: AttachmentPresentation;
  foreground: boolean;
  onPlay?(): void;
  neighbors?: VideoNeighbors;
}) {
  const isVideo = videoFile(asset.item.name, asset.item.type);
  const { key, state, uri, shown } = useAttachment({
    asset: isVideo ? undefined : asset,
    presentation,
    message: page.message,
  });
  useEffect(() => {
    if (foreground && photo(asset.item) && state.kind === "cached")
      presentation.prepare(key);
  }, [asset.item, foreground, key, presentation, state.kind]);
  if (isVideo)
    return (
      <VideoAttachment
        asset={asset}
        message={page.message}
        metadata={asset.item}
        dialog={dialog}
        presentation={presentation}
        foreground={foreground}
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

export function SharedMediaPhotoPage({
  row,
  senderName,
  presentation,
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  row: SharedMediaRow;
  senderName: string;
  presentation: AttachmentPresentation;
}) {
  const dialog = useDialog();
  const message: IMessage = {
    _id: JSON.stringify([row.group, row.message, row.source, row.item.index]),
    text: row.caption,
    createdAt: row.at * 1000,
    user: { _id: row.sender, name: senderName },
  };
  const asset: Asset = {
    target: [row.group, row.message, row.source, row.item.index],
    item: row.item,
  };

  return (
    <GalleryPage
      {...page}
      message={message}
      asset={asset}
      dialog={dialog}
      presentation={presentation}
      foreground
    />
  );
}

function Attachment({
  dialog,
  openPhoto,
  conversation,
  foreground,
  visible,
  ...props
}: AttachmentProps & {
  dialog: ReturnType<typeof useDialog>;
  openPhoto: () => void;
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
  const { width } = useWindowDimensions();
  const position =
    props.message.user._id === identity.publicKey ? "right" : "left";
  const isPhoto = photo(item);
  const audio = audioFile(item.name, item.type);
  const visualWidth = Math.min(width * 0.67, 300);
  const frame = {
    width: visualWidth,
    height: posterSize(item, visualWidth),
    borderRadius: 16,
  };
  useEffect(() => {
    if (foreground && state.kind === "cached" && isPhoto)
      presentation.prepare(key);
  }, [foreground, isPhoto, key, presentation, state.kind]);
  const notice = attachmentNotice(state);

  let body;
  if (isPhoto && uri) {
    body = (
      <MessageImage
        currentMessage={{ ...shown, image: uri }}
        imageStyle={frame}
        onOpen={openPhoto}
      />
    );
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
            .catch(() =>
              dialog.show({ title: t("mediaOpenFailed"), tone: "error" }),
            )
        }
      />
    );
  }

  return (
    <View style={styles.item}>
      {body}
      {notice && <Ink kind="caption">{t(notice)}</Ink>}
    </View>
  );
}

function VideoAttachment({
  asset,
  dialog,
  message,
  metadata,
  presentation,
  poster,
  upload,
  position,
  foreground,
  frame,
  onOpen,
  neighbors,
  timestampBackdrop,
}: Omit<AttachmentProps, "asset"> & {
  asset?: Asset;
  dialog: ReturnType<typeof useDialog>;
  metadata: Item | PendingVideoFile["file"];
  poster?: ImageRef;
  upload?: VideoUpload;
  position?: "left" | "right";
  foreground: boolean;
  frame?: { width: number; height: number; borderRadius: number };
  onOpen?: () => void;
  neighbors?: VideoNeighbors;
  timestampBackdrop?: boolean;
}) {
  const { video, roundNotes } = useLocal();
  const { t, i18n } = useTranslation(["video", "messages", "common"]);
  const { reduceMotion } = useTheme();
  const { state, shown } = useAttachment({ asset, message, presentation });
  const target = asset?.target;
  const [group, id, event, index] = target ?? [];
  const [opening, setOpening] = useState(false);
  const previewKey = message.rowKey ?? message._id;
  const [lastPoster, setLastPoster] = useState<{
    key: IMessage["_id"];
    image: ImageRef;
  }>();
  if (poster && (lastPoster?.key !== previewKey || lastPoster.image !== poster))
    setLastPoster({ key: previewKey, image: poster });
  const preview =
    poster ?? (lastPoster?.key === previewKey ? lastPoster.image : undefined);
  const round =
    "round" in metadata ? metadata.round : metadata.presentation === "round";
  const ready =
    state.kind === "cached" ||
    state.kind === "local" ||
    (!round &&
      target !== undefined &&
      preview !== undefined &&
      state.kind === "checking");
  const busy =
    opening ||
    (target !== undefined &&
      !ready &&
      (state.kind === "checking" || state.kind === "preparing"));
  const videoStyle = useVideoFrame(metadata.dimensions);
  const duration = Number(metadata.duration);
  const fraction = upload?.progress;
  const percent =
    fraction == null
      ? undefined
      : new Intl.NumberFormat(i18n.language, { style: "percent" }).format(
          Math.floor(fraction * 100) / 100,
        );
  const acquire = useCallback<NonNullable<RoundNotePlayback["acquire"]>>(
    (options) => {
      if (
        group === undefined ||
        id === undefined ||
        event === undefined ||
        index === undefined
      )
        throw new Error("MediaUnavailable");
      const source = presentation.authorize([group, id, event, index]);
      if (!source) throw new Error("MediaUnavailable");
      return roundNotes.acquire(source, options);
    },
    [event, group, id, index, presentation, roundNotes],
  );

  async function play() {
    if (!target || busy || !ready) return;
    const source = presentation.authorize(target);
    if (!source) return;
    setOpening(true);
    onOpen?.();
    try {
      const opened = await video.open(
        {
          kind: "attachment",
          source,
          title: metadata.name,
          duration:
            Number.isFinite(duration) && duration > 0 ? duration : undefined,
          dimensions: metadata.dimensions,
          thumbhash: metadata.thumbhash,
        },
        { neighbors },
      );
      if (!opened && presentation.authorize(target))
        void dialog.show({
          title: t("video:settings.openFailed"),
          tone: "error",
        });
    } finally {
      setOpening(false);
    }
  }

  const notice = target ? attachmentNotice(state) : undefined;
  return (
    <View style={styles.item}>
      <Transition.Boundary
        id={
          target ? videoOrigin(target) : String(message.rowKey ?? message._id)
        }
        enabled={target !== undefined && !round && !reduceMotion && !onOpen}
        style={round || onOpen ? undefined : styles.videoOrigin}
      >
        <MessageVideo
          currentMessage={{
            ...shown,
            _id: upload?.id ?? shown._id,
            duration:
              Number.isFinite(duration) && duration > 0 ? duration : undefined,
            videoNote: round,
            isDownloadRequired:
              target !== undefined && shown.isDownloadRequired,
            transfer:
              fraction === undefined
                ? shown.transfer
                : { type: "upload", progress: fraction },
          }}
          position={position}
          poster={
            <Poster
              item={metadata}
              source={preview}
              timestampBackdrop={timestampBackdrop}
            />
          }
          videoStyle={round ? undefined : [videoStyle, frame]}
          onOpen={!round && target ? () => void play() : undefined}
          isPreparing={busy}
          isPlaybackDisabled={!ready}
          roundNotePlayback={
            round
              ? {
                  messageId: message._id,
                  acquire: foreground && ready ? acquire : undefined,
                  claim: (stop) =>
                    Boolean(target && presentation.authorize(target)) &&
                    roundNotes.claim(stop),
                }
              : undefined
          }
          uploadProgressLabel={percent}
          retryAction={
            upload?.retry && {
              label: t("common:retry"),
              icon: <Icon name="refresh" size={22} color="#fff" />,
              onPress: upload.retry,
            }
          }
          transferAccessibilityLabel={
            percent == null ? undefined : t("common:cancel") + ", " + percent
          }
        />
      </Transition.Boundary>
      {notice && <Ink kind="caption">{t(`messages:${notice}`)}</Ink>}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs, padding: space.xs },
  item: { gap: space.xs },
  placeholder: { backgroundColor: "#333438", overflow: "hidden" },
  videoOrigin: { alignSelf: "flex-start" },
  timestampTint: { backgroundColor: "rgba(0,0,0,0.36)" },
  opaqueTimestamp: { backgroundColor: "#303035" },
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
