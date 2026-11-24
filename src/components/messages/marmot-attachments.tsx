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
  VideoTransferOverlay,
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
  Alert,
  Modal,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Ink } from "@/components/ui/kit";
import {
  attachmentKey,
  type AttachmentPresentation,
  type AttachmentTarget,
} from "@/core/marmot/attachment-presentation";
import type { MarmotMessage } from "@/core/marmot/native";
import { speechSource } from "@/core/speech/service";
import type { SpeechSource } from "@/core/speech/types";
import { formatDuration } from "@/i18n/format";
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
type GalleryPhoto = { asset: Asset; message: IMessage };

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

export function conversationPhotos(
  group: string,
  messages: readonly (IMessage & { row?: MarmotMessage })[],
) {
  const photos: GalleryPhoto[] = [];
  for (const message of [...messages].reverse()) {
    const row = message.row;
    if (!row?.sourceId || row.deleted || row.invalidationStatus) continue;
    for (const item of acceptedAttachments(row)) {
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
  gallery: GalleryPhoto[];
  foreground: boolean;
  visible: boolean;
}) {
  const [selected, setSelected] = useState<number>();
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
  const galleryIndex =
    selected === undefined
      ? -1
      : gallery.findIndex(
          ({ asset }) =>
            asset.target[1] === row.id && asset.item.index === selected,
        );
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
              openPhoto={() => setSelected(asset.item.index)}
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
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  asset: Asset;
  presentation: AttachmentPresentation;
  foreground: boolean;
}) {
  const { key, state, uri, shown } = useAttachment({
    asset,
    presentation,
    message: page.message,
  });
  useEffect(() => {
    if (foreground && state.kind === "cached") presentation.prepare(key);
  }, [foreground, key, presentation, state.kind]);
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
  conversation,
  foreground,
  visible,
  ...props
}: AttachmentProps & {
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
  const { identity, calling } = useLocal();
  const transcript = useVoiceTranscript(
    source,
    state.kind === "cached" || state.kind === "local",
    visible,
  );
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
  const audio = audioFile(item.name, item.type);
  const round = video && item.round === true;
  const visualWidth = round
    ? Math.min(width, height) * 0.54
    : Math.min(width * 0.67, 300);
  const frame = {
    width: visualWidth,
    height: round ? visualWidth : posterSize(item, visualWidth),
    borderRadius: round ? visualWidth / 2 : 16,
  };
  useEffect(() => {
    if (
      foreground &&
      state.kind === "cached" &&
      (isPhoto || (!callActive && video))
    )
      presentation.prepare(key);
  }, [callActive, foreground, isPhoto, key, presentation, state.kind, video]);
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
  } else if (video && uri && !callActive) {
    body = (
      <MessageVideo
        currentMessage={{
          ...shown,
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

const styles = StyleSheet.create({
  stack: { gap: space.xs, padding: space.xs },
  item: { gap: space.xs },
  placeholder: { backgroundColor: "#333438", overflow: "hidden" },
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
