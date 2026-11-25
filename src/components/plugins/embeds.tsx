import { router } from "expo-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStore } from "zustand";
import { useAudioActions } from "@/components/audio/actions";
import { Action, Icon, IconButton, Ink } from "@/components/ui/kit";
import { ListRow } from "@/components/ui/list-group";
import { useDialog } from "@/components/ui/dialog";
import { DownloadProgressRing } from "@/components/downloads/progress-ring";
import { audioFile } from "@/core/audio/types";
import { sourceId } from "@/core/downloads/types";
import type { Content } from "@/core/marmot/message-content";
import { openLocalAttachment } from "@/core/media/open-local-attachment";
import { pluginMessageText } from "@/core/plugins/message-content";
import { openDownloadedVideo } from "@/core/video/open";
import { videoFile } from "@/core/video/types";
import { formatBytes } from "@/i18n/format";
import type { TorrentFile } from "@/plugins/torrents/contracts";
import { torrentDownload } from "@/plugins/torrents/downloads";
import type { TorrentEmbed } from "@/plugins/torrents/magnets";
import { useLocal } from "@/services/local-context";

export function PluginEmbeds({
  group,
  message,
  event,
  text,
  content,
  eligible,
}: {
  group: string;
  message: string;
  event: string;
  text: string;
  content?: Content | null;
  eligible: boolean;
}) {
  const { torrents } = useLocal();
  if (!torrents.supported) return null;
  const embeds = torrents.match({
    text: pluginMessageText(text, content),
    eligible: true,
  });
  return embeds.map((embed) => {
    const Renderer = renderers[embed.renderer];
    return (
      <Renderer
        key={embed.id}
        {...{ group, message, event, embed, eligible }}
      />
    );
  });
}

const filePage = 12;
const renderers = { torrent: TorrentCard };

function TorrentCard({
  group,
  message,
  event,
  embed,
  eligible,
}: {
  group: string;
  message: string;
  event: string;
  embed: TorrentEmbed;
  eligible: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const { torrents, authorizeTorrent, downloads } = useLocal();
  const { infoHash, uri } = embed.payload;
  const state = useStore(torrents.state);
  const available =
    state.delivery?.kind === "installed" && state.enabled && !state.loadFailed;
  const mounted = useRef<AbortController | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => torrents.subscribe(infoHash, notify),
    [infoHash, torrents],
  );
  const resolution = useSyncExternalStore(subscribe, () =>
    torrents.snapshot(infoHash),
  );
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => {
      controller.abort();
      if (mounted.current === controller) mounted.current = null;
    };
  }, [group, message, event, infoHash, uri, eligible, available]);

  const request = useCallback(
    async (explicit: boolean) => {
      const signal = mounted.current?.signal;
      if (!signal || signal.aborted || !eligible || !available) return;
      if (explicit) setFailed(false);
      try {
        await authorizeTorrent(
          { group, message, sourceId: event, hash: infoHash },
          signal,
          torrents.resolve,
        );
      } catch {
        if (!signal.aborted) setFailed(true);
      }
    },
    [
      authorizeTorrent,
      available,
      eligible,
      event,
      group,
      infoHash,
      message,
      torrents,
    ],
  );

  useEffect(() => {
    if (!eligible || !available) return;
    const timer = setTimeout(() => {
      if (state.policy === "automatic") void request(false);
      else torrents.readCached(infoHash);
    }, 0);
    return () => clearTimeout(timer);
  }, [available, eligible, infoHash, request, state.policy, torrents]);

  const dialog = useDialog();
  async function download(files: TorrentFile[]) {
    const signal = mounted.current?.signal;
    if (!eligible || !signal || !available) return;
    try {
      await authorizeTorrent(
        { group, message, sourceId: event, hash: infoHash },
        signal,
        async () => {
          for (const file of files)
            downloads.enqueue(torrentDownload(infoHash, file));
        },
      );
      if (!signal.aborted) setSelected(new Set());
    } catch {
      if (!signal.aborted)
        void dialog.show({ title: t("pluginActionFailed"), tone: "error" });
    }
  }

  async function play(file: TorrentFile) {
    const signal = mounted.current?.signal;
    if (!eligible || !signal || !available) return;
    const source = torrentDownload(infoHash, file);
    const id = sourceId(source);
    try {
      await authorizeTorrent(
        { group, message, sourceId: event, hash: infoHash },
        signal,
        async () => {
          if (!downloads.get(id)) downloads.enqueue(source);
        },
      );
      if (
        !signal.aborted &&
        !(await openDownloadedVideo(id, { allowProgressive: true }))
      )
        throw new Error("OpenFailed");
    } catch {
      if (!signal.aborted)
        void dialog.show({ title: t("pluginActionFailed"), tone: "error" });
    }
  }

  const resolved = typeof resolution === "object" ? resolution : undefined;
  const bytes = (size: number) => formatBytes(size, i18n.language);
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.mark}>
          <Icon name="plugins" size={18} />
        </View>
        <View style={styles.copy}>
          <Ink kind="label" numberOfLines={2}>
            {available && resolved ? resolved.name : t("torrents")}
          </Ink>
          <Ink muted kind="caption">
            {resolved && available
              ? t("torrentDetails", {
                  count: resolved.files.length,
                  size: bytes(
                    resolved.files.reduce((sum, file) => sum + file.size, 0),
                  ),
                })
              : t("torrentPublicTransfer")}
          </Ink>
        </View>
      </View>
      {!available ? (
        <Action
          size="sm"
          variant="ghost"
          disabled={!eligible}
          onPress={() =>
            router.push(
              state.delivery?.kind === "installed"
                ? torrents.descriptor.settingsRoute
                : "/settings/plugins",
            )
          }
        >
          {state.delivery?.kind === "installed"
            ? t("torrentPluginSettings")
            : t("pluginInstall")}
        </Action>
      ) : !resolved ? (
        <Action
          size="sm"
          disabled={!eligible || resolution === "resolving"}
          onPress={() => void request(true)}
        >
          {resolution === "resolving"
            ? t("torrentResolving")
            : resolution === "failed" || failed
              ? t("pluginRetry")
              : t("torrentResolve")}
        </Action>
      ) : (
        <>
          <Action
            size="sm"
            variant="ghost"
            onPress={() => setPage((value) => (value === null ? 0 : null))}
          >
            {page === null ? t("torrentShowFiles") : t("torrentHideFiles")}
          </Action>
          {page !== null &&
            resolved.files
              .slice(page * filePage, (page + 1) * filePage)
              .map((file) => (
                <TorrentFileRow
                  key={file.index}
                  {...{ file, infoHash, eligible }}
                  selected={selected.has(file.index)}
                  onToggle={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(file.index)) next.delete(file.index);
                      else next.add(file.index);
                      return next;
                    })
                  }
                  onDownload={() => void download([file])}
                  onPlay={() => void play(file)}
                />
              ))}
          {page !== null && page > 0 && (
            <Action size="sm" variant="ghost" onPress={() => setPage(page - 1)}>
              {t("torrentPreviousFiles")}
            </Action>
          )}
          {page !== null && (page + 1) * filePage < resolved.files.length && (
            <Action size="sm" variant="ghost" onPress={() => setPage(page + 1)}>
              {t("torrentMoreFiles")}
            </Action>
          )}
          {page !== null && selected.size > 0 && (
            <Action
              size="sm"
              disabled={!eligible}
              onPress={() =>
                void download(
                  resolved.files.filter((file) => selected.has(file.index)),
                )
              }
            >
              {t("torrentDownloadSelected", { count: selected.size })}
            </Action>
          )}
        </>
      )}
    </View>
  );
}

function TorrentFileRow({
  file,
  infoHash,
  selected,
  eligible,
  onToggle,
  onDownload,
  onPlay,
}: {
  file: TorrentFile;
  infoHash: string;
  selected: boolean;
  eligible: boolean;
  onToggle(): void;
  onDownload(): void;
  onPlay(): void;
}) {
  const { downloads } = useLocal();
  const { t, i18n } = useTranslation("downloads");
  const audio = useAudioActions();
  const dialog = useDialog();
  const source = torrentDownload(infoHash, file);
  const id = sourceId(source);
  const job = useSyncExternalStore(downloads.subscribe, () =>
    downloads.get(id),
  );
  const running =
    job &&
    (job.state === "active" ||
      job.state === "waiting" ||
      job.state === "queued");
  const fraction = job && file.size > 0 ? job.received / file.size : 0;
  const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
  const percentLabel = running
    ? (percent / 100).toLocaleString(i18n.language, { style: "percent" })
    : "";
  async function open() {
    if (videoFile(source.name, source.type)) {
      if (!(await openDownloadedVideo(id))) throw new Error("OpenFailed");
    } else if (audioFile(source.name, source.type)) {
      await audio.open({
        kind: "attachment",
        source,
        title: source.name,
        voice: false,
      });
    } else {
      await downloads.open(id, (file) => openLocalAttachment(file, true));
    }
  }
  const select = job?.state !== "completed" && !running;
  const stream =
    job?.state !== "completed" && !job?.intent && downloads.canStream(source);
  return (
    <ListRow
      title={source.name}
      detail={formatBytes(file.size, i18n.language)}
      selected={select ? selected : undefined}
      selectionRole="checkbox"
      onPress={select && eligible ? onToggle : undefined}
      showChevron={false}
      trailing={
        <View style={styles.fileActions}>
          {stream && (
            <Action
              size="sm"
              variant="ghost"
              disabled={!eligible}
              onPress={onPlay}
            >
              {t(
                !job
                  ? "playAndDownload"
                  : job.state === "paused"
                    ? "resumeAndPlay"
                    : job.state === "failed"
                      ? "retryAndPlay"
                      : "play",
              )}
            </Action>
          )}
          {running ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={source.name}
              accessibilityValue={{ min: 0, max: 100, now: percent }}
            >
              <DownloadProgressRing
                size={46}
                fraction={fraction}
                indeterminate={!job.received}
                spinning={job.state === "active"}
              >
                <Ink
                  kind="badge"
                  adjustsFontSizeToFit
                  numberOfLines={1}
                  style={styles.percent}
                >
                  {percentLabel}
                </Ink>
              </DownloadProgressRing>
            </View>
          ) : !job || job.state === "cancelled" ? (
            <IconButton
              icon="download"
              iconSize={18}
              label={t("startDownload")}
              tone="plain"
              disabled={!eligible}
              onPress={onDownload}
            />
          ) : (
            <Action
              size="sm"
              variant="ghost"
              disabled={!eligible}
              onPress={() => {
                if (job.state === "completed") {
                  void open().catch(() =>
                    dialog.show({ title: t("openFailed"), tone: "error" }),
                  );
                } else {
                  router.push("/downloads");
                }
              }}
            >
              {job.state === "completed"
                ? t("open")
                : job.state === "paused"
                  ? t("paused")
                  : t("failed")}
            </Action>
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    margin: theme.space.sm,
    padding: theme.space.sm,
    gap: theme.space.xs,
    backgroundColor: theme.colors.raised,
    borderRadius: theme.radius.group,
    borderColor: theme.colors.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  fileActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  percent: { fontVariant: ["tabular-nums"] },
  mark: {
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: theme.radius.round,
    backgroundColor: theme.colors.selected,
  },
  copy: { flex: 1, gap: theme.space.xs },
}));
