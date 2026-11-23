import { File } from "expo-file-system";
import type { MediaSdk } from "../media";
import { localMediaUri } from "../media/open-local-attachment";
import { sendOnAttachmentServers } from "./media-send";
import { marmot, type MarmotUpload } from "./native";

export async function sendMarmotAttachment({
  sdk,
  group,
  source,
  caption,
  reply,
  token,
  allowed,
  progress,
  onStaged,
  mirrorFailed,
  signal,
}: {
  sdk: MediaSdk;
  group: string;
  source:
    | { kind: "files"; files: MarmotUpload[]; saveDraft: boolean }
    | { kind: "draft"; sizes: readonly number[] };
  caption: string | null;
  reply: string | null;
  token: string;
  allowed: () => boolean;
  progress: (fraction: number) => void;
  onStaged?: (sizes: readonly number[]) => void;
  mirrorFailed: () => void;
  signal: AbortSignal;
}) {
  const sizes =
    source.kind === "draft"
      ? source.sizes
      : source.files.map((file) => {
          const size = new File(localMediaUri(file.path)).size;
          if (!size) throw new Error("InvalidMediaPath");
          return size;
        });
  if (source.kind === "files" && source.saveDraft) {
    if (signal.aborted || !allowed()) return;
    await marmot.stageMediaDraft(
      group,
      source.files,
      caption ?? "",
      token,
      reply,
      signal,
    );
    onStaged?.(sizes);
    if (signal.aborted || !allowed()) return;
  }
  const files =
    source.kind === "files" && !source.saveDraft ? source.files : [];
  const origins = () =>
    sdk.configured("attachment").map(({ origin }) => origin);
  const maxCiphertext = Math.max(...sizes.map((size) => size + 16));
  const accepted = await sendOnAttachmentServers({
    origins: origins(),
    isEnabled: (origin) => allowed() && origins().includes(origin),
    signal,
    check: (origin) => sdk.check(origin, "attachment", signal, maxCiphertext),
    send: (origin) =>
      marmot.sendMedia(
        group,
        files,
        caption,
        token,
        origin,
        reply,
        progress,
        signal,
      ),
  });
  if (accepted.blobs.length && !signal.aborted && allowed())
    void sdk
      .mirrorAttachments(accepted.blobs, signal, allowed)
      .then((ok) => {
        if (!ok && !signal.aborted && allowed()) mirrorFailed();
      })
      .catch(() => {
        if (!signal.aborted && allowed()) mirrorFailed();
      });
  return accepted;
}
