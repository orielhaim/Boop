import {
  MediaViewer,
  MediaViewerPage,
  type IMessage,
} from "@kesha-antonov/react-native-chat";
import { Image } from "expo-image";
import {
  type ComponentProps,
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
  View,
  useWindowDimensions,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { downloadId } from "@/core/downloads/types";
import {
  attachmentKey,
  type AttachmentPresentation,
  type AttachmentTarget,
} from "@/core/marmot/attachment-presentation";
import type { SharedMediaRow } from "@/core/marmot/native";
import {
  mediaCategory,
  mediaKey,
  mediaTarget,
} from "@/core/marmot/shared-media";
import { localMediaUri } from "@/core/media/open-local-attachment";
import { formatBytes, formatDuration } from "@/i18n/format";
import { resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { usePresentedName } from "@/components/people/use-person";
import { space, useTheme } from "@/theme";
import { Icon, Ink, type IconName } from "@/components/ui/kit";
import { SharedMediaPhotoPage } from "@/components/messages/marmot-attachments";
import { VoiceMessageAttachment } from "@/components/audio/attachment";
import { useVoiceTranscript } from "@/components/messages/voice-transcript";
import { mediaDownload } from "./use-library";
import { DialogBoundary, useDialog } from "@/components/ui/dialog";

type MediaState = ReturnType<AttachmentPresentation["state"]>;
type DownloadItem = NonNullable<
  ReturnType<ReturnType<typeof useLocal>["downloads"]["get"]>
>;
const checking: MediaState = { kind: "checking" };
const cached: MediaState = { kind: "cached" };
const remote: MediaState = { kind: "remote" };

function useMediaState(
  row: SharedMediaRow,
  presentation: AttachmentPresentation,
  observe: boolean,
) {
  const { group, message, source, item } = row;
  const target = useMemo(
    (): AttachmentTarget => [group, message, source, item.index],
    [group, item.index, message, source],
  );
  const key = attachmentKey(target);
  const subscribe = useCallback(
    (notify: () => void) =>
      observe ? presentation.subscribe(target, notify) : () => undefined,
    [observe, presentation, target],
  );
  const getState = useCallback(
    () => (observe ? presentation.state(key) : checking),
    [key, observe, presentation],
  );
  const observedState = useSyncExternalStore(subscribe, getState);
  const { downloads } = useLocal();
  const id = downloadId(target);
  const subscribeDownload = useCallback(
    (notify: () => void) =>
      observe ? downloads.subscribe(notify) : () => undefined,
    [downloads, observe],
  );
  const getDownload = useCallback(
    () => (observe ? downloads.get(id) : undefined),
    [downloads, id, observe],
  );
  const download = useSyncExternalStore(subscribeDownload, getDownload);
  const state = observe ? observedState : row.local ? cached : remote;
  return { key, state, download };
}

function isPhoto(row: SharedMediaRow) {
  return row.item.type.startsWith("image/");
}

function mediaIcon(row: SharedMediaRow): IconName {
  if (row.category === "video") return "camera";
  if (row.item.voice) return "microphone";
  if (row.category === "audio") return "audio";
  if (row.category === "image") return "media";
  const ext = row.item.name.split(".").at(-1)?.toLowerCase();
  if (row.item.type === "application/pdf" || ext === "pdf") return "pdfFile";
  if (ext && ["zip", "rar", "7z", "tar", "gz"].includes(ext))
    return "archiveFile";
  if (ext && ["xlsx", "xls", "csv", "ods"].includes(ext)) return "sheetFile";
  if (ext && ["docx", "doc", "odt", "rtf", "txt"].includes(ext))
    return "documentFile";
  return "file";
}

function transferLabel(
  state: MediaState,
  job: DownloadItem | undefined,
  t: (key: string, options?: object) => string,
) {
  if (job?.state === "queued") return t("downloads:queued");
  if (job?.state === "waiting") return t("downloads:waiting");
  if (state.kind === "downloading") {
    if (state.verifying) return t("messages:mediaVerifying");
    const percent = job?.total
      ? Math.floor((job.received / job.total) * 100)
      : undefined;
    return percent === undefined
      ? t("common:checking")
      : t("messages:voiceDownloadProgress", { percent });
  }
  if (state.kind === "failed") return t("messages:voiceDownloadFailed");
  if (state.kind === "cancelled") return t("messages:voiceDownloadCancelled");
  if (state.kind === "paused") return t("downloads:paused");
  if (state.kind === "checking") return t("common:checking");
  if (
    state.kind === "cached" ||
    state.kind === "local" ||
    state.kind === "preparing"
  )
    return t("messages:sharedMedia.downloaded");
  return t("messages:mediaDownload");
}

function TransferBadge({
  state,
  job,
  grid,
}: {
  state: MediaState;
  job?: DownloadItem;
  grid: boolean;
}) {
  const { t } = useTranslation(["messages", "common", "downloads"]);
  const { colors } = useTheme();
  const percent =
    job?.total && state.kind === "downloading"
      ? Math.floor((job.received / job.total) * 100)
      : undefined;
  const busy = state.kind === "downloading";
  if (
    state.kind === "checking" ||
    state.kind === "preparing" ||
    state.kind === "cached" ||
    state.kind === "local"
  )
    return null;
  const icon =
    state.kind === "paused"
      ? "pause"
      : state.kind === "failed" || state.kind === "cancelled"
        ? "refresh"
        : "download";
  const label = transferLabel(state, job, t);
  const iconInk = grid ? colors.onMedia : colors.accent;
  return (
    <View
      style={grid ? styles.gridTransfer : styles.rowTransfer}
      accessibilityLabel={label}
      accessibilityRole="image"
    >
      {busy ? (
        <ActivityIndicator size="small" color={iconInk} />
      ) : (
        <Icon name={icon} size={grid ? 16 : 18} color={iconInk} />
      )}
      {percent !== undefined && (
        <Ink kind="caption" style={{ color: iconInk }}>
          {percent}%
        </Ink>
      )}
    </View>
  );
}

export function SharedMediaItem({
  row,
  grid,
  selected,
  selection,
  visible,
  groupLabel,
  presentation,
  onPress,
  onLongPress,
  onMenu,
}: {
  row: SharedMediaRow;
  grid: boolean;
  selected: boolean;
  selection: boolean;
  visible: boolean;
  groupLabel?: string;
  presentation: AttachmentPresentation;
  onPress: () => void;
  onLongPress: () => void;
  onMenu: () => void;
}) {
  const { t, i18n } = useTranslation(["messages", "common", "downloads"]);
  const { colors } = useTheme();
  const { key, state, download } = useMediaState(row, presentation, visible);
  const senderName = usePresentedName(row.sender);
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const localPath =
    visible && state.kind === "local"
      ? localMediaUri(state.lease.path)
      : undefined;
  const image = isPhoto(row);
  const visual = mediaCategory(row) === "visual";
  const label = [
    row.caption || row.item.name,
    senderName,
    groupLabel,
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(row.at * 1_000),
    transferLabel(state, download, t),
  ]
    .filter(Boolean)
    .join(". ");

  useEffect(() => {
    if (visible && image && state.kind === "cached") presentation.prepare(key);
  }, [image, key, presentation, state.kind, visible]);

  const thumb = image ? localPath : undefined;
  const posterSource = thumb ? { uri: thumb } : undefined;
  const categoryIcon = mediaIcon(row);
  const duration = row.item.duration && formatDuration(row.item.duration);
  const gif = row.item.type === "image/gif";
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(row.at * 1_000);
  const metadata = [
    date,
    duration,
    row.item.size ? formatBytes(row.item.size, locale) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Pressable
      accessibilityRole={selection ? "checkbox" : "button"}
      accessibilityLabel={label}
      accessibilityState={selection ? { checked: selected } : undefined}
      accessibilityActions={
        !selection && grid
          ? [{ name: "menu", label: t("messages:sharedMedia.moreActions") }]
          : undefined
      }
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "menu") onMenu();
      }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      style={[
        styles.item,
        grid ? styles.gridItem : styles.rowItem,
        selected && styles.selectedItem,
      ]}
    >
      {grid ? (
        <View style={styles.gridFrame}>
          <Image
            source={posterSource}
            autoplay={false}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="none"
            placeholder={
              row.item.thumbhash ? { thumbhash: row.item.thumbhash } : undefined
            }
            placeholderContentFit="cover"
          />
          {!posterSource && !row.item.thumbhash && (
            <View style={styles.filePreview}>
              <Icon name={categoryIcon} size={30} color={colors.accent} />
            </View>
          )}
          {(categoryIcon === "camera" || gif) && (
            <View style={styles.playBadge}>
              {!gif && <Icon name="play" size={12} color={colors.onMedia} />}
              {(duration || gif) && (
                <Ink kind="badge" style={styles.mediaInk}>
                  {gif ? "GIF" : duration}
                </Ink>
              )}
            </View>
          )}
          {!posterSource && !selection && (
            <TransferBadge state={state} job={download} grid />
          )}
          {selection && <SelectionMark selected={selected} />}
        </View>
      ) : (
        <>
          <View style={styles.rowPreview}>
            {image ? (
              <Image
                source={posterSource}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                cachePolicy="none"
                placeholder={
                  row.item.thumbhash
                    ? { thumbhash: row.item.thumbhash }
                    : undefined
                }
                placeholderContentFit="cover"
              />
            ) : (
              <Icon name={categoryIcon} size={22} color={colors.accent} />
            )}
            {visual && categoryIcon === "camera" && (
              <View style={styles.rowPlayBadge}>
                <Icon name="play" size={11} color={colors.onMedia} />
              </View>
            )}
          </View>
          <View style={styles.rowText}>
            <Ink kind="control" numberOfLines={1} ellipsizeMode="middle">
              {row.item.round
                ? t("messages:sharedMedia.roundVideo")
                : row.item.voice
                  ? senderName
                  : row.item.name}
            </Ink>
            <Ink kind="caption" muted numberOfLines={1}>
              {[senderName, groupLabel, metadata].filter(Boolean).join(" · ")}
            </Ink>
            {!selection && row.item.voice && visible && (
              <LibraryVoiceNote
                row={row}
                name={senderName}
                presentation={presentation}
                state={state}
              />
            )}
          </View>
          <TransferBadge state={state} job={download} grid={false} />
          {selection ? (
            <SelectionMark selected={selected} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("messages:sharedMedia.moreActions")}
              hitSlop={8}
              onPress={(event) => {
                event.stopPropagation();
                onMenu();
              }}
              style={styles.rowMenu}
            >
              <Icon name="more" size={19} color={colors.muted} />
            </Pressable>
          )}
        </>
      )}
    </Pressable>
  );
}

function LibraryVoiceNote({
  row,
  name,
  presentation,
  state,
}: {
  row: SharedMediaRow;
  name: string;
  presentation: AttachmentPresentation;
  state: MediaState;
}) {
  const { identity } = useLocal();
  const source = useMemo(
    () => mediaDownload(row, identity.publicKey),
    [identity.publicKey, row],
  );
  const ready = state.kind === "cached" || state.kind === "local";
  const transcript = useVoiceTranscript(source.voice, ready, true);
  return (
    <VoiceMessageAttachment
      track={{
        kind: "attachment",
        source,
        voice: true,
        title: name,
        duration: row.item.duration,
      }}
      message={{
        _id: downloadId(source.target),
        user: { _id: row.sender, name },
        createdAt: row.at * 1000,
        text: row.caption,
        duration: row.item.duration,
        waveform: row.item.waveform?.map((value) => value / 31),
      }}
      transcript={transcript}
      authorize={() => Boolean(presentation.authorize(source.target))}
      ready={ready}
      checking={state.kind === "checking" || state.kind === "preparing"}
      downloading={state.kind === "downloading"}
      progress={state.kind === "downloading" ? state.progress : undefined}
      outgoing={false}
    />
  );
}

function SelectionMark({ selected }: { selected: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.selectionMark, selected && styles.selectionMarkOn]}>
      {selected && <Icon name="check" size={15} color={colors.onAccent} />}
    </View>
  );
}

function ViewerPage({
  row,
  index,
  count,
  groupLabel,
  presentation,
  onMenu,
  onMore,
  more,
  onApproachTail,
  onPlay,
  onDownload,
  moreLabel,
  menuLabel,
  ...page
}: ComponentProps<typeof MediaViewerPage> & {
  count: number;
  groupLabel?: string;
  row: SharedMediaRow;
  presentation: AttachmentPresentation;
  onMenu: (row: SharedMediaRow, dialog?: ReturnType<typeof useDialog>) => void;
  onMore: () => void;
  more: boolean;
  onApproachTail(count: number): void;
  onPlay: (row: SharedMediaRow) => void;
  onDownload: (row: SharedMediaRow) => void;
  moreLabel: string;
  menuLabel: string;
}) {
  const { t, i18n } = useTranslation([
    "messages",
    "common",
    "downloads",
    "audio",
  ]);
  const { colors } = useTheme();
  const dialog = useDialog();
  const { width, height } = useWindowDimensions();
  const { key, state, download } = useMediaState(row, presentation, true);
  const canView =
    state.kind === "cached" ||
    state.kind === "local" ||
    state.kind === "preparing";
  useEffect(() => {
    if (more && index >= count - 2) onApproachTail(count);
  }, [count, index, more, onApproachTail]);
  const senderName = usePresentedName(row.sender);
  const canDownload =
    state.kind === "remote" ||
    state.kind === "failed" ||
    state.kind === "cancelled" ||
    state.kind === "paused";
  const percent = download?.total
    ? Math.floor((download.received / download.total) * 100)
    : undefined;
  const status = transferLabel(state, download, t);
  const itemContext = [
    row.caption || row.item.name,
    senderName,
    new Intl.DateTimeFormat(resolveLanguage(i18n.resolvedLanguage), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(row.at * 1_000),
    groupLabel,
  ]
    .filter(Boolean)
    .join(". ");

  const startDownload = () => {
    if (presentation.authorize(mediaTarget(row))) onDownload(row);
  };
  const cancelDownload = () => {
    if (presentation.authorize(mediaTarget(row))) presentation.cancel(key);
  };

  return (
    <View style={{ width, height }}>
      {canView && row.category === "image" ? (
        <SharedMediaPhotoPage
          {...page}
          index={index}
          row={row}
          presentation={presentation}
          senderName={senderName}
        />
      ) : (
        <View style={styles.viewerPlaceholder}>
          {row.item.thumbhash ? (
            <Image
              style={StyleSheet.absoluteFill}
              placeholder={{ thumbhash: row.item.thumbhash }}
              placeholderContentFit="contain"
              cachePolicy="none"
            />
          ) : (
            <Icon name={mediaIcon(row)} size={36} color={colors.muted} />
          )}
          {canView && row.category === "video" && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("audio:play")}
              onPress={() => onPlay(row)}
              style={styles.viewerPlay}
            >
              <Icon name="play" size={27} color={colors.onMedia} />
            </Pressable>
          )}
        </View>
      )}
      <View pointerEvents="box-none" style={styles.viewerControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${menuLabel}. ${itemContext}`}
          onPress={() => onMenu(row, dialog)}
          style={styles.viewerButton}
        >
          <Icon name="more" size={20} color={colors.onMedia} />
        </Pressable>
        <View pointerEvents="none" style={styles.viewerMeta}>
          <Ink kind="caption" numberOfLines={1} style={styles.mediaInk}>
            {[senderName, groupLabel].filter(Boolean).join(" · ")}
          </Ink>
        </View>
        {canDownload ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("messages:mediaDownload")}. ${itemContext}`}
            onPress={startDownload}
            style={styles.downloadPrompt}
          >
            <Icon name="download" size={20} color={colors.onMedia} />
            <Ink kind="control" style={styles.mediaInk}>
              {t("messages:mediaDownload")}
            </Ink>
          </Pressable>
        ) : state.kind === "downloading" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common:cancel")}
            onPress={cancelDownload}
            style={styles.downloadPrompt}
          >
            {state.verifying ? (
              <ActivityIndicator color={colors.onMedia} />
            ) : (
              <Icon name="close" size={20} color={colors.onMedia} />
            )}
            <Ink kind="control" style={styles.mediaInk}>
              {state.verifying
                ? status
                : percent === undefined
                  ? status
                  : `${percent}%`}
            </Ink>
          </Pressable>
        ) : state.kind === "checking" || state.kind === "preparing" ? (
          <View style={styles.viewerBusy} accessibilityLabel={status}>
            <ActivityIndicator color={colors.onMedia} />
          </View>
        ) : null}
        {more && index === count - 1 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={moreLabel}
            onPress={onMore}
            style={styles.viewerMore}
          >
            <Icon name="more" size={17} color={colors.onMedia} />
            <Ink kind="caption" style={styles.mediaInk}>
              {moreLabel}
            </Ink>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function SharedMediaViewer({
  rows,
  selected,
  presentation,
  onClose,
  onMore,
  onPlay,
  more,
  onMenu,
  onDownload,
  groupLabel,
}: {
  rows: readonly SharedMediaRow[];
  selected: string;
  presentation: AttachmentPresentation;
  onClose: () => void;
  onMore: () => void;
  onPlay: (row: SharedMediaRow) => void;
  more: boolean;
  onMenu: (row: SharedMediaRow, dialog?: ReturnType<typeof useDialog>) => void;
  onDownload: (row: SharedMediaRow) => void;
  groupLabel?: (row: SharedMediaRow) => string | undefined;
}) {
  const { t } = useTranslation(["messages", "common", "downloads"]);
  const [order, setOrder] = useState(() => rows.map(mediaKey));
  const loadedThrough = order.at(-1);
  const tail = loadedThrough
    ? rows.findIndex((row) => mediaKey(row) === loadedThrough)
    : -1;
  if (tail >= 0 && tail < rows.length - 1) {
    const known = new Set(order);
    const following = rows
      .slice(tail + 1)
      .map(mediaKey)
      .filter((key) => !known.has(key));
    if (following.length) setOrder([...order, ...following]);
  }
  const requested = useRef(0);
  const onApproachTail = useCallback(
    (count: number) => {
      if (requested.current === count) return;
      requested.current = count;
      onMore();
    },
    [onMore],
  );
  const gallery = useMemo(() => {
    const available = new Map(rows.map((row) => [mediaKey(row), row]));
    return order.flatMap((key) => {
      const row = available.get(key);
      return row ? [row] : [];
    });
  }, [order, rows]);
  const initialIndex = gallery.findIndex((row) => mediaKey(row) === selected);
  const messages = useMemo<IMessage[]>(
    () =>
      gallery.map((row) => ({
        _id: mediaKey(row),
        text: row.caption,
        createdAt: row.at * 1_000,
        user: { _id: row.sender, name: t("messages:sharedMedia.sender") },
      })),
    [gallery, t],
  );
  if (initialIndex < 0 || gallery.length === 0) return null;

  return (
    <MediaViewer
      items={messages}
      initialIndex={initialIndex}
      onClose={onClose}
      renderPage={(page) => {
        const row = gallery[page.index];
        return row ? (
          <DialogBoundary>
            <ViewerPage
              {...page}
              row={row}
              count={gallery.length}
              presentation={presentation}
              onMenu={onMenu}
              onDownload={onDownload}
              onMore={onMore}
              more={more}
              onApproachTail={onApproachTail}
              onPlay={onPlay}
              moreLabel={t("downloads:more")}
              menuLabel={t("messages:sharedMedia.moreActions")}
              groupLabel={groupLabel?.(row)}
            />
          </DialogBoundary>
        ) : null;
      }}
    />
  );
}

const styles = StyleSheet.create(({ colors, radius }) => ({
  item: { overflow: "hidden", borderRadius: radius.small },
  gridItem: { aspectRatio: 1, backgroundColor: colors.recessed },
  rowItem: {
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  selectedItem: { backgroundColor: colors.selected },
  gridFrame: { flex: 1, backgroundColor: colors.recessed },
  filePreview: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.recessed,
  },
  viewerPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0b0d12",
  },
  viewerPlay: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    width: 64,
    height: 64,
    backgroundColor: "rgba(0,0,0,0.56)",
  },
  playBadge: {
    position: "absolute",
    bottom: space.xs,
    end: space.xs,
    minWidth: 22,
    height: 22,
    flexDirection: "row",
    gap: space.xs,
    paddingHorizontal: space.xs,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  rowPlayBadge: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  mediaInk: { color: colors.onMedia },
  mediaMutedInk: { color: "rgba(255,255,255,0.78)" },
  gridTransfer: {
    position: "absolute",
    top: space.xs,
    start: space.xs,
    minWidth: 28,
    height: 28,
    paddingHorizontal: space.xs,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  rowTransfer: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: space.xs,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    borderRadius: radius.round,
    backgroundColor: colors.selected,
  },
  selectionMark: {
    position: "absolute",
    top: space.xs,
    end: space.xs,
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.onMedia,
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  selectionMarkOn: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  rowPreview: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: radius.small,
    backgroundColor: colors.recessed,
  },
  rowText: { flex: 1, gap: 3 },
  rowMenu: { padding: space.xs },
  viewerControls: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "flex-end",
    paddingTop: space.xl,
    paddingEnd: space.md,
    gap: space.sm,
  },
  viewerButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  viewerMeta: {
    alignSelf: "flex-start",
    maxWidth: "78%",
    marginTop: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.small,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  downloadPrompt: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  viewerBusy: {
    minWidth: 40,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  viewerMore: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.round,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
}));
