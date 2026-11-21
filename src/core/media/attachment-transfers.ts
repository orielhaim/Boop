import { randomUUID } from "expo-crypto";
import { Platform } from "react-native";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "@/db/schema";
import { attachmentUploads } from "@/db/schema";
import {
  attachmentUploadUrl,
  BlossomError,
  type FilePut,
  type UploadContext,
  type UploadProgress,
} from "./blossom";
import { putAttachmentFile } from "./download-native";

const prefix = "boop-put-";
const androidBackgroundThreshold = 8 * 1024 * 1024;

type NativeTasks =
  typeof import("@kesha-antonov/react-native-background-downloader");
type NativeUpload = Awaited<
  ReturnType<NativeTasks["getExistingUploadTasks"]>
>[number];
type PutRequest = Parameters<FilePut>[0];
type UploadRow = typeof attachmentUploads.$inferSelect;

function nativeTasks(): NativeTasks {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@kesha-antonov/react-native-background-downloader");
}

export function usesBackgroundUpload(size: number) {
  return Platform.OS === "android" && size >= androidBackgroundThreshold;
}

export function createAttachmentTransfers<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  owner: string,
  allowedOrigin: (origin: string) => boolean,
) {
  let startup: Promise<void> | undefined;
  const active = new Map<string, () => void>();
  const owns = eq(attachmentUploads.owner, owner);
  const rowFor = (id: string) =>
    db
      .select()
      .from(attachmentUploads)
      .where(and(owns, eq(attachmentUploads.messageId, id)))
      .get();
  const drop = (nativeId: string) =>
    db
      .delete(attachmentUploads)
      .where(and(owns, eq(attachmentUploads.nativeId, nativeId)))
      .run();
  const acknowledge = (id: string) => nativeTasks().completeHandler(id);

  function receipt(
    row: UploadRow,
    result: { status: number; body: string },
    size: number,
  ) {
    if (!allowedOrigin(row.origin)) throw new BlossomError("cancelled");
    const url = attachmentUploadUrl(result, row.origin, row.hash, size);
    const saved = db
      .update(attachmentUploads)
      .set({ resultUrl: url })
      .where(and(owns, eq(attachmentUploads.nativeId, row.nativeId)))
      .returning({ id: attachmentUploads.nativeId })
      .get();
    if (!saved) throw new BlossomError("cancelled");
    return url;
  }

  async function stop(task: NativeUpload) {
    if (task.state === "DONE") acknowledge(task.id);
    await task.stop();
  }

  function waitForUpload(
    task: NativeUpload,
    row: UploadRow,
    signal: AbortSignal,
    progress: NonNullable<PutRequest["progress"]>,
    size: number,
    start: boolean,
  ) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      function finish(
        error?: unknown,
        result?: { status: number; body: string },
      ) {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
        active.delete(task.id);
        if (result) resolve(result);
        else reject(error);
      }
      function stopWaiting(error: unknown) {
        if (settled) return;
        drop(row.nativeId);
        void stop(task).catch(() => undefined);
        finish(error);
      }
      const cancel = () => stopWaiting(new BlossomError("cancelled"));
      function complete({
        responseCode: status,
        responseBody: body,
      }: {
        responseCode: number;
        responseBody: string;
      }) {
        if (settled) return;
        try {
          if (signal.aborted) throw new BlossomError("cancelled");
          receipt(row, { status, body }, size);
          acknowledge(task.id);
          finish(undefined, { status, body });
        } catch (error) {
          if (error instanceof BlossomError) {
            drop(row.nativeId);
            acknowledge(task.id);
            finish(error);
          } else {
            finish(new BlossomError("cancelled"));
          }
        }
      }
      async function recheck(expired: boolean) {
        try {
          const tasks = await nativeTasks().getExistingUploadTasks();
          if (settled) return;
          const current = tasks.find(({ id }) => id === task.id);
          if (
            current?.state === "DONE" &&
            current.responseCode !== undefined &&
            current.responseBody !== undefined
          ) {
            complete({
              responseCode: current.responseCode,
              responseBody: current.responseBody,
            });
          } else if (current?.state !== "UPLOADING" || expired) {
            stopWaiting(new BlossomError(expired ? "timeout" : "network"));
          }
        } catch {
          if (expired) stopWaiting(new BlossomError("timeout"));
        }
      }
      task
        .progress(({ bytesUploaded, bytesTotal }) => {
          if (!settled && !signal.aborted) progress(bytesUploaded, bytesTotal);
        })
        .done(complete)
        .error(({ errorCode }) => {
          if (settled) return;
          drop(row.nativeId);
          finish(undefined, {
            status: errorCode > 0 ? errorCode : 503,
            body: "",
          });
        });
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener("abort", cancel, { once: true });
      active.set(task.id, cancel);
      try {
        if (start) task.start();
        else {
          // A completion can arrive between discovery and installing handlers.
          progress(task.bytesUploaded, task.bytesTotal);
          void recheck(false);
          deadline = setTimeout(() => void recheck(true), 310_000);
        }
      } catch (error) {
        stopWaiting(error);
      }
    });
  }

  const put: FilePut = async (request) => {
    const context = request.context;
    if (!context || !usesBackgroundUpload(request.size))
      return putAttachmentFile(request);
    await startup;
    request.beforeStart?.();
    if (request.signal.aborted) throw new BlossomError("cancelled");
    const origin = new URL(request.url).origin;
    if (!allowedOrigin(origin)) throw new BlossomError("cancelled");
    const row: UploadRow = {
      messageId: context.id,
      nativeId: prefix + randomUUID(),
      owner,
      peer: context.peer,
      hash: request.hash,
      source: request.uri,
      origin,
      resultUrl: null,
    };
    db.insert(attachmentUploads).values(row).run();
    let task: NativeUpload;
    try {
      task = nativeTasks().createUploadTask({
        id: row.nativeId,
        url: request.url,
        source: decodeURIComponent(request.uri),
        method: "PUT",
        mimeType: "application/octet-stream",
        headers: request.headers,
        metadata: { expiresAt: request.expiresAt },
      });
    } catch (error) {
      drop(row.nativeId);
      throw error;
    }
    return waitForUpload(
      task,
      row,
      request.signal,
      request.progress ?? (() => {}),
      request.size,
      true,
    );
  };

  async function recover(
    context: UploadContext,
    source: string,
    hash: string,
    size: number,
    signal: AbortSignal,
    progress: (value: UploadProgress) => void,
  ) {
    await startup;
    const row = rowFor(context.id);
    if (!row) return;
    if (signal.aborted) throw new BlossomError("cancelled");
    if (
      row.peer !== context.peer ||
      row.hash !== hash ||
      row.source !== source ||
      !allowedOrigin(row.origin)
    ) {
      drop(row.nativeId);
      return;
    }
    if (row.resultUrl) return row.resultUrl;
    const tasks = await nativeTasks().getExistingUploadTasks();
    const task = tasks.find(({ id }) => id === row.nativeId);
    if (!task) {
      drop(row.nativeId);
      return;
    }
    if (signal.aborted) throw new BlossomError("cancelled");
    if (
      task.state === "DONE" &&
      task.responseCode !== undefined &&
      task.responseBody !== undefined
    ) {
      try {
        const url = receipt(
          row,
          { status: task.responseCode, body: task.responseBody },
          size,
        );
        acknowledge(task.id);
        return url;
      } catch (error) {
        if (error instanceof BlossomError) {
          drop(row.nativeId);
          acknowledge(task.id);
        }
        throw error;
      }
    }
    if (task.state !== "UPLOADING") {
      await stop(task);
      drop(row.nativeId);
      return;
    }
    const result = await waitForUpload(
      task,
      row,
      signal,
      (sent, total) => {
        if (total === size)
          progress(Math.min(99, Math.floor((100 * sent) / total)));
      },
      size,
      false,
    );
    return (
      rowFor(context.id)?.resultUrl ??
      attachmentUploadUrl(result, row.origin, hash, size)
    );
  }

  return {
    put,
    recover,
    reconcile(authorized: (row: UploadRow) => boolean) {
      if (Platform.OS !== "android") return;
      startup ??= (async () => {
        const uploads = await nativeTasks().getExistingUploadTasks();
        const rows = db.select().from(attachmentUploads).where(owns).all();
        const retained = new Set<string>();
        for (const row of rows) {
          if (authorized(row) && allowedOrigin(row.origin))
            retained.add(row.nativeId);
          else drop(row.nativeId);
        }
        await Promise.all(
          uploads
            .filter(
              (task) => task.id.startsWith(prefix) && !retained.has(task.id),
            )
            .map(stop),
        );
      })().catch(() => {
        startup = undefined;
      });
    },
    forget(id: string) {
      const row = rowFor(id);
      if (row) drop(row.nativeId);
    },
    revoke(shouldCancel: (row: UploadRow) => boolean) {
      if (Platform.OS !== "android") return;
      const rows = db.select().from(attachmentUploads).where(owns).all();
      for (const row of rows) {
        if (!shouldCancel(row)) continue;
        const cancel = active.get(row.nativeId);
        if (cancel) cancel();
        else {
          drop(row.nativeId);
          try {
            void nativeTasks()
              .getNativeModule()
              .stopUploadTask?.(row.nativeId)
              ?.catch(() => undefined);
          } catch {
            // A native task that cannot be queried cannot be reattached.
          }
        }
      }
    },
  };
}
