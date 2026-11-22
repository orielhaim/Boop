import {
  type IMessage,
  MediaViewer,
  MediaViewerPage,
  MessageAudio,
  MessageFile,
  MessageImage,
  MessageVideo,
  VideoTransferOverlay,
  VoiceWaveform,
} from "@kesha-antonov/react-native-chat";
import { Directory, File } from "expo-file-system";
import { Image } from "expo-image";
import { saveToLibraryAsync } from "expo-media-library/legacy";
import { shareAsync } from "expo-sharing";
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
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Action, Icon, Ink } from "@/components/ui/kit";
import {
  attachmentKey,
  type AttachmentPresentation,
  type AttachmentTarget,
} from "@/core/marmot/attachment-presentation";
import type { MarmotMessage } from "@/core/marmot/native";
import { formatDuration } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

type Item = MarmotMessage["attachments"][number];
type Asset = { target: AttachmentTarget; item: Item };
type AttachmentProps = {
  asset: Asset;
  message: IMessage;
  presentation: AttachmentPresentation;
};
type GalleryPhoto = { asset: Asset; message: IMessage };

export function conversationPhotos(
  group: string,
  messages: readonly (IMessage & { row?: MarmotMessage })[],
) {
  const photos: GalleryPhoto[] = [];
  for (const message of [...messages].reverse()) {
    const row = message.row;
    if (!row?.sourceId || row.deleted || row.invalidated) continue;
    for (const item of row.attachments) {
      if (photo(item))
        photos.push({
          asset: { item, target: [group, row.id, row.sourceId, item.index] },
          message,
        });
    }
  }
  return photos;
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
      state.kind === "cancelled",
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

function localUri(path: string) {
  if (!path.startsWith("/")) throw new Error("InvalidMediaPath");
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
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
  row,
  message,
  presentation,
  gallery,
}: {
  group: string;
  row: MarmotMessage;
  message: IMessage;
  presentation: AttachmentPresentation;
  gallery: GalleryPhoto[];
}) {
  const [selected, setSelected] = useState<number>();
  const assets = useMemo(() => {
    const source = row.sourceId;
    if (!source) return [];
    return row.attachments.map((item): Asset => ({
      item,
      target: [group, row.id, source, item.index],
    }));
  }, [group, row.attachments, row.id, row.sourceId]);
  const galleryIndex =
    selected === undefined
      ? -1
      : gallery.findIndex(
          ({ asset }) =>
            asset.target[1] === row.id && asset.item.index === selected,
        );
  return (
    <View style={styles.stack}>
      {assets.map((asset) => (
        <Attachment
          key={attachmentKey(asset.target)}
          asset={asset}
          message={message}
          presentation={presentation}
          openPhoto={() => setSelected(asset.item.index)}
        />
      ))}
      {galleryIndex >= 0 && (
        <Modal
          animationType="fade"
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

function GalleryPage({
  asset,
  presentation,
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  asset: Asset;
  presentation: AttachmentPresentation;
}) {
  const { key, state, uri, shown } = useAttachment({
    asset,
    presentation,
    message: page.message,
  });
  useEffect(() => {
    if (state.kind === "cached") presentation.prepare(key);
  }, [key, presentation, state.kind]);
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
  ...props
}: AttachmentProps & { openPhoto: () => void }) {
  const { t } = useTranslation("messages");
  const {
    asset: { item, target },
    presentation,
  } = props;
  const { state, key, uri, shown } = useAttachment(props);
  const { colors } = useTheme();
  const { identity, calling } = useLocal();
  const call = useSyncExternalStore(
    calling.store.subscribe,
    calling.store.getState,
  ).call;
  const callActive = Boolean(call && call.phase !== "ended");
  const { width, height } = useWindowDimensions();
  const position =
    props.message.user._id === identity.publicKey ? "right" : "left";
  const isPhoto = photo(item);
  const video = item.type.startsWith("video/");
  const audio = item.type.startsWith("audio/");
  const round = video && item.round === true;
  const visualWidth = round
    ? Math.min(width, height) * 0.54
    : Math.min(width * 0.67, 300);
  const frame = {
    width: visualWidth,
    height: round ? visualWidth : posterSize(item, visualWidth),
    borderRadius: round ? visualWidth / 2 : 16,
  };
  const [playRequested, setPlayRequested] = useState(false);
  useEffect(() => {
    if (state.kind === "cached" && (isPhoto || (!callActive && video)))
      presentation.prepare(key);
  }, [callActive, isPhoto, key, presentation, state.kind, video]);
  useEffect(
    () =>
      calling.store.subscribe(({ call }) => {
        if (call && call.phase !== "ended") setPlayRequested(false);
      }),
    [calling],
  );

  const progress = state.kind === "downloading";
  const notice =
    state.kind === "failed"
      ? t("voiceDownloadFailed")
      : state.kind === "cancelled"
        ? t("voiceDownloadCancelled")
        : progress && state.verifying
          ? t("mediaVerifying")
          : undefined;

  function document(action: "open" | "share" | "save") {
    void presentation
      .useLocalFile(target, async (file) => {
        const source = new File(localUri(file.path));
        if (action === "save" && (isPhoto || video)) {
          await saveToLibraryAsync(source.uri);
        } else if (action === "save" && Platform.OS === "android") {
          const location = await Directory.pickDirectoryAsync();
          if (location) await source.copy(location);
        } else if (action === "open" && Platform.OS === "android") {
          const { startActivityAsync } = await import("expo-intent-launcher");
          await startActivityAsync("android.intent.action.VIEW", {
            data: source.contentUri,
            type: file.type,
            flags: 1,
          });
        } else {
          await shareAsync(source.uri, {
            mimeType: file.type,
            dialogTitle: item.name,
          });
        }
      })
      .catch(() => Alert.alert(t("mediaOpenFailed")));
  }

  let body;
  if (isPhoto && uri) {
    body = (
      <MessageImage
        currentMessage={{ ...shown, image: uri }}
        imageStyle={frame}
        onOpen={openPhoto}
      />
    );
  } else if (video && uri && !callActive) {
    body = (
      <MessageVideo
        currentMessage={{
          ...shown,
          _id: props.message._id,
          video: uri,
          videoNote: round,
        }}
        position={position}
        videoStyle={round ? undefined : frame}
      />
    );
  } else if (isPhoto || video) {
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
  } else if (audio && uri && !callActive) {
    body = (
      <MessageAudio
        currentMessage={{
          ...shown,
          _id: props.message._id,
          audio: uri,
        }}
        position={position}
        autoPlay={playRequested}
        onPlaybackEnded={() => setPlayRequested(false)}
      />
    );
  } else if (audio) {
    const cached = state.kind === "cached" || Boolean(uri);
    const busy =
      progress || state.kind === "preparing" || state.kind === "checking";
    const label = progress
      ? t("voiceCancelDownload")
      : cached
        ? t("voicePlay")
        : t("voiceDownload");
    body = (
      <View style={styles.audio}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={(!progress && busy) || (cached && callActive)}
          style={[styles.play, { borderColor: colors.text }]}
          onPress={() => {
            if (progress) presentation.cancel(key);
            else if (cached) {
              setPlayRequested(true);
              presentation.prepare(key);
            } else if (shown.isDownloadRequired) presentation.download(key);
          }}
        >
          {progress ? (
            <Icon name="hangup" color={colors.text} size={18} />
          ) : busy ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Icon
              name={cached ? "play" : "download"}
              color={colors.text}
              size={20}
            />
          )}
        </Pressable>
        <View style={styles.track}>
          <VoiceWaveform
            waveform={shown.waveform}
            color={colors.text}
            progress={shown.transfer?.progress}
          />
          <Ink kind="caption">
            {progress && state.progress != null
              ? t("voiceDownloadProgress", {
                  percent: Math.floor(state.progress * 100),
                })
              : item.duration != null
                ? formatDuration(item.duration)
                : t("voiceMessage")}
          </Ink>
        </View>
      </View>
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
        onPress={() => document("open")}
      />
    );
  }

  const documentAvailable =
    !isPhoto &&
    !audio &&
    !video &&
    (state.kind === "cached" || state.kind === "local");
  return (
    <View style={styles.item}>
      {body}
      {notice && <Ink kind="caption">{notice}</Ink>}
      {documentAvailable && (
        <View style={styles.actions}>
          <Action size="sm" onPress={() => document("save")}>
            {t("mediaSave")}
          </Action>
          <Action size="sm" onPress={() => document("share")}>
            {t("mediaShare")}
          </Action>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs, padding: space.xs },
  item: { gap: space.xs },
  placeholder: { backgroundColor: "#333438", overflow: "hidden" },
  actions: { flexDirection: "row", gap: space.xs, flexWrap: "wrap" },
  duration: {
    position: "absolute",
    bottom: 8,
    end: 8,
    color: "#fff",
    backgroundColor: "#0009",
    borderRadius: 8,
    paddingHorizontal: 5,
  },
  audio: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    padding: 8,
    width: 240,
  },
  play: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: 22,
  },
  track: { flex: 1 },
});
