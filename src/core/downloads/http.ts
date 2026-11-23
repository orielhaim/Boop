import {
  completeHandler,
  createDownloadTask,
  getExistingDownloadTasks,
  setConfig,
  type DownloadTask,
} from "@kesha-antonov/react-native-background-downloader";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Directory, File, Paths } from "expo-file-system";
import type { DownloadTransport } from "./transport";
import type { HttpDownload } from "./types";

const license = {
  url: "https://raw.githubusercontent.com/orielhaim/Boop/215d8d674f966c0ced29f152804c60f66f6b294c/LICENSE",
  size: 35139,
  hash: "c44092b8eedad8d95e86c27e44005a2ade430646bf9d04b9f53f8c19e25206fd",
};

export const boopLicense: HttpDownload = {
  kind: "http",
  artifact: "boop-license",
  name: "Boop-LICENSE.txt",
  type: "text/plain",
  total: license.size,
  hash: license.hash,
  expiresAt: null,
};

const namespace = "boop-public-";
export function createHttpDownloads(
  scope: string,
): DownloadTransport<HttpDownload> {
  const nativeId = namespace + scope;
  const root = new Directory(Paths.document, "public-downloads");
  const directory = new Directory(root, scope);
  const staged = () => new File(directory, "license.part");
  const retained = () => new File(directory, boopLicense.name);
  let task: DownloadTask | undefined;

  function verified(file: File) {
    return (
      file.exists &&
      file.size === license.size &&
      bytesToHex(sha256(file.bytesSync())) === license.hash
    );
  }

  function publish() {
    const output = retained();
    if (verified(output)) return true;
    const part = staged();
    if (!verified(part)) return false;
    if (output.exists) output.delete();
    part.move(output);
    return true;
  }

  async function stop() {
    if (!task) return;
    const current = task;
    const before = current.state;
    try {
      if (before !== "DONE" && before !== "FAILED") await current.stop();
      await completeHandler(current.id);
    } catch (error) {
      current.state = before;
      throw error;
    }
    if (task === current) task = undefined;
  }

  return {
    async recover(owned) {
      setConfig({ progressInterval: 350 });
      const native = await getExistingDownloadTasks();
      for (const item of native) {
        if (!item.id.startsWith(namespace)) continue;
        if (item.id === nativeId && owned.length) {
          task = item;
          continue;
        }
        if (item.state !== "DONE" && item.state !== "FAILED") await item.stop();
        await completeHandler(item.id);
      }
      if (root.exists) {
        for (const folder of root.list()) {
          if (
            folder instanceof Directory &&
            /^[0-9a-f]{64}$/.test(folder.name) &&
            folder.name !== scope
          )
            folder.delete();
        }
      }
      if (!owned.length && directory.exists) directory.delete();
      if (task?.state === "DONE") {
        publish();
        await stop();
      }
    },
    async status() {
      if (task?.state === "DOWNLOADING") return "downloading";
      if (publish()) return "ready";
      return task?.state === "PAUSED" ? "paused" : "unavailable";
    },
    async transfer(_source, progress, signal, attach) {
      if (signal.aborted) return "interrupted";
      if (!task || task.state === "DONE" || task.state === "FAILED") {
        if (publish()) return "ready";
        if (attach) return "interrupted";
        if (staged().exists) staged().delete();
        directory.create({ intermediates: true, idempotent: true });
        task = createDownloadTask({
          id: nativeId,
          url: license.url,
          destination: staged().uri,
          isAllowedOverRoaming: false,
          notificationTitle: "Boop download",
        });
      }
      const current = task;
      return new Promise<string>((resolve, reject) => {
        const detach = () => finish("interrupted");
        function finish(state: string) {
          signal.removeEventListener("abort", detach);
          resolve(state);
        }
        signal.addEventListener("abort", detach, { once: true });
        const update = (received: number) => {
          if (!signal.aborted)
            progress({ state: "downloading", received, total: license.size });
        };
        current
          .progress(({ bytesDownloaded }) => update(bytesDownloaded))
          .done(() => {
            if (signal.aborted) return;
            try {
              finish(publish() ? "ready" : "failed");
            } catch {
              finish("storage_blocked");
            } finally {
              void Promise.resolve(completeHandler(nativeId)).catch(
                () => undefined,
              );
              if (task === current) task = undefined;
            }
          })
          .error(({ errorCode, error }) => {
            if (signal.aborted) return;
            if (
              errorCode === 1006 ||
              errorCode === -3003 ||
              /ENOSPC|no space left|insufficient.space/i.test(error)
            )
              finish("storage_blocked");
            else if ([401, 403, 404, 410].includes(errorCode))
              finish("unavailable");
            else if (
              [-1009, -1005, -1004, -1003, -1001, 408, 429, 503].includes(
                errorCode,
              ) ||
              /timed out|network is unreachable|unable to resolve host/i.test(
                error,
              )
            )
              finish("interrupted");
            else finish("failed");
            void Promise.resolve(completeHandler(nativeId)).catch(
              () => undefined,
            );
            if (task === current) task = undefined;
          });
        update(current.bytesDownloaded);
        if (current.state === "PENDING") current.start();
        else if (!attach && current.state === "PAUSED")
          void current.resume().catch((error) => {
            current.state = "PAUSED";
            signal.removeEventListener("abort", detach);
            reject(error);
          });
      });
    },
    async control(_source, action) {
      if (action === "pause" && task?.state === "DOWNLOADING") {
        const current = task;
        try {
          await current.pause();
        } catch (error) {
          current.state = "DOWNLOADING";
          throw error;
        }
        return;
      }
      if (action === "pause") return;
      await stop();
      if (action === "cancel") publish();
      if (staged().exists) staged().delete();
      if (action === "remove" && retained().exists) retained().delete();
    },
    async open(_source, consume) {
      const file = retained();
      if (!verified(file)) throw new Error("MediaUnavailable");
      await consume({
        path: decodeURIComponent(file.uri.slice("file://".length)),
        type: boopLicense.type,
        name: file.name,
      });
    },
  };
}
