import { Directory, File, Paths } from "expo-file-system";
import { marmot } from "@/core/marmot/native";
import type { DownloadManager } from "@/core/downloads/manager";
import type { DownloadFile } from "@/core/downloads/transport";
import { sourceId } from "@/core/downloads/types";
import type { LocalMediaHandle, MediaHandle, MediaSource } from "./source";
import { waitForDownload } from "./download";
import {
  authorizedMarmotAttachment,
  waitForMediaAuthority,
} from "./authorization";
import { localMediaUri } from "./open-local-attachment";

export type AcquireOptions = {
  signal: AbortSignal;
  download: boolean;
  progressive?: boolean;
  invalidate(): void;
};

export function createMediaSources<T extends MediaSource>({
  scope,
  downloads,
  ready,
  allowed,
  canDownload,
  blocked,
  subscribePrivacy,
}: {
  scope: string;
  downloads: DownloadManager;
  ready(): boolean;
  allowed(track: T): boolean;
  canDownload(): boolean;
  blocked(sender: string): boolean;
  subscribePrivacy(listener: () => void): () => void;
}) {
  const directory = new Directory(Paths.document, "audio", scope);
  const deviceFile = (track: Extract<MediaSource, { kind: "device" }>) => {
    if (!/^[a-f0-9-]{36}(\.[a-z0-9]{1,12})?$/u.test(track.file))
      throw new Error("InvalidMediaPath");
    return new File(directory, track.file);
  };

  function acquire(
    track: T,
    options: AcquireOptions & { progressive?: false },
  ): Promise<LocalMediaHandle>;
  function acquire(track: T, options: AcquireOptions): Promise<MediaHandle>;
  async function acquire(
    track: T,
    options: AcquireOptions,
  ): Promise<MediaHandle> {
    const check = () => {
      if (options.signal.aborted || !allowed(track))
        throw new Error("MediaUnavailable");
    };
    check();
    let closeWindow: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;
    let releaseFile: (() => Promise<void>) | undefined;
    let unpin: (() => void) | undefined;
    let released: Promise<void> | undefined;
    const retired = Promise.withResolvers<void>();
    let file: DownloadFile;
    let expiresAt = track.kind === "attachment" ? track.source.expiresAt : null;
    function release() {
      released ??= (async () => {
        unsubscribe?.();
        await Promise.allSettled([closeWindow?.(), releaseFile?.()]);
        unpin?.();
        retired.resolve();
      })();
      return released;
    }
    try {
      if (track.kind === "device") {
        const local = deviceFile(track);
        if (!local.exists) throw new Error("MediaUnavailable");
        file = {
          path: decodeURIComponent(local.uri.slice(7)),
          name: track.title,
          type: track.type,
        };
      } else if (track.kind === "local") {
        file = track.file;
      } else {
        const { source } = track;
        const id = sourceId(source);
        const download = async () => {
          check();
          if (!options.download || !canDownload())
            throw new Error("MediaUnavailable");
          if (downloads.get(id)?.state === "completed") {
            await downloads.reconcile();
            check();
          }
          if (downloads.get(id)?.state === "paused") downloads.resume(id);
          else downloads.enqueue(source);
          await waitForDownload(downloads, source, options.signal);
          check();
        };
        let stopWatchingWindow: (() => void) | undefined;
        if (source.kind === "marmot") {
          const [group, message] = source.target;
          if (!ready()) throw new Error("MediaUnavailable");
          check();
          const window = await marmot.openConversation(group, {
            target: message,
          });
          closeWindow = async () => {
            stopWatchingWindow?.();
            await window.close();
          };
          const authorized = () => {
            if (!ready() || !allowed(track)) return false;
            const row = authorizedMarmotAttachment(
              window.getState(),
              source,
              blocked,
            );
            if (row?.expiresAt != null)
              expiresAt = Math.min(expiresAt ?? Infinity, row.expiresAt * 1000);
            return Boolean(row);
          };
          await waitForMediaAuthority(window, options.signal);
          check();
          if (!authorized()) throw new Error("MediaUnavailable");
          const validate = () => {
            const priorExpiry = expiresAt;
            if (!authorized() || (priorExpiry !== expiresAt && unpin))
              options.invalidate();
          };
          const stopWindow = window.subscribe(validate);
          const stopPrivacy = subscribePrivacy(validate);
          stopWatchingWindow = () => {
            stopWindow();
            stopPrivacy();
          };
          if ((await marmot.retainedAttachmentBytes(...source.target)) === null)
            await download();
          check();
          if (!authorized()) throw new Error("MediaUnavailable");
          const lease = await marmot.openAttachment(...source.target);
          if (!lease) throw new Error("MediaUnavailable");
          releaseFile = () => marmot.releaseAttachment(lease.lease);
          if (!authorized()) throw new Error("MediaUnavailable");
          file = lease;
        } else {
          if (
            options.progressive &&
            downloads.canStream(source) &&
            downloads.get(id)?.state !== "completed"
          ) {
            if (!canDownload()) throw new Error("MediaUnavailable");
            if (options.download) {
              if (downloads.get(id)?.state === "paused") downloads.resume(id);
              else downloads.enqueue(source);
            }
            unpin = downloads.holdForPlayback(
              source,
              () => {
                options.invalidate();
                return retired.promise;
              },
              true,
            );
            if (!unpin) throw new Error("MediaUnavailable");
            const result = await downloads.openProgressive(
              source,
              options.signal,
            );
            if (result.kind === "progressive") {
              releaseFile = result.read.release;
              check();
              unsubscribe = downloads.subscribe(() => {
                const job = downloads.get(id);
                if (
                  !job ||
                  job.intent === "remove" ||
                  job.intent === "cancel" ||
                  job.state === "cancelled"
                )
                  options.invalidate();
              });
              return {
                ...result.read,
                kind: "progressive",
                sourceId: id,
                mimeType: source.type,
                expiresAt,
                cancelReads: result.read.release,
                release,
              };
            }
            if (result.kind !== "completed")
              throw new Error("MediaUnavailable");
            unpin();
            unpin = undefined;
          }
          if (downloads.get(id)?.state !== "completed") await download();
          let local: DownloadFile | undefined;
          await downloads.open(id, async (value) => {
            local = value;
          });
          if (!local) throw new Error("MediaUnavailable");
          file = local;
        }
        unpin = downloads.holdForPlayback(source, () => {
          options.invalidate();
          return retired.promise;
        });
        if (!unpin) throw new Error("MediaUnavailable");
        let managed = downloads.get(id)?.state === "completed";
        unsubscribe = downloads.subscribe(() => {
          const job = downloads.get(id);
          if (job?.state === "completed") managed = true;
          if (
            managed &&
            (job?.state !== "completed" || job.intent === "remove")
          )
            options.invalidate();
        });
      }
      check();
      return {
        kind: "local",
        file,
        uri: localMediaUri(file.path),
        expiresAt,
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  return { acquire, directory, deviceFile };
}
