import { marmot } from "@/core/marmot/native";
import type { DownloadTransport } from "./transport";
import type { MarmotDownload } from "./types";

export const marmotDownloads: DownloadTransport<MarmotDownload> = {
  async transfer({ target }, progress, signal) {
    const state = await marmot.downloadAttachment(
      ...target,
      (received, total, state) => progress({ received, total, state }),
      signal,
    );
    if (state === "ready" && !signal.aborted) {
      const bytes = await marmot
        .retainedAttachmentBytes(...target)
        .catch(() => null);
      if (bytes !== null) progress({ state, received: bytes, total: bytes });
    }
    return state;
  },
  status: ({ target }) => marmot.attachmentTransferState(...target),
  async control({ target }, action) {
    // MarmotKit cancellation retains the resumable ciphertext checkpoint.
    // Pause keeps the job eligible for Resume. Remove also deletes local media.
    const changed = await marmot.controlAttachment(
      ...target,
      action === "remove" ? "remove" : "cancel",
    );
    if (
      !changed &&
      action === "remove" &&
      (await marmot.attachmentTransferState(...target)) === "ready"
    )
      throw new Error("DownloadRemoveFailed");
  },
  async open({ target }, consume) {
    const file = await marmot.openAttachment(...target);
    if (!file) throw new Error("MediaUnavailable");
    try {
      await consume(file);
    } finally {
      await marmot.releaseAttachment(file.lease);
    }
  },
};
