import { File } from "expo-file-system";
import type { MediaSdk } from "../media";
import {
  type AttachmentMetadata,
  attachmentMetadataEvent,
  attachmentMetadataKind,
  sendOnAttachmentServers,
} from "./media-send";
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
  mirrorFailed,
  signal,
}: {
  sdk: MediaSdk;
  group: string;
  source:
    | { kind: "files"; files: MarmotUpload[]; saveDraft: boolean }
    | { kind: "draft"; attachments: AttachmentMetadata[] };
  caption: string | null;
  reply: string | null;
  token: string;
  allowed: () => boolean;
  progress: (fraction: number) => void;
  mirrorFailed: () => void;
  signal: AbortSignal;
}) {
  const attachments =
    source.kind === "draft"
      ? source.attachments
      : source.files.map((file, index): AttachmentMetadata => {
          const size = new File("file://" + file.path).size;
          if (!size) throw new Error("InvalidMediaPath");
          return {
            index,
            size,
            duration: file.duration
              ? Math.min(3_600, Math.max(1, Number(file.duration)))
              : undefined,
            waveform: file.waveform?.split(",").slice(0, 64).map(Number),
            round: file.presentation === "round" ? true : undefined,
          };
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
    if (signal.aborted || !allowed()) return;
  }
  const files =
    source.kind === "files" && !source.saveDraft ? source.files : [];
  const origins = () =>
    sdk.configured("attachment").map(({ origin }) => origin);
  const maxCiphertext = Math.max(...attachments.map(({ size }) => size + 16));
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
  if (accepted.id && allowed() && !signal.aborted) {
    const body = attachmentMetadataEvent(accepted.id, attachments);
    void marmot
      .sendSpecial(group, attachmentMetadataKind, body, null)
      .catch(() => undefined);
  }
  if (accepted.blobs.length && !signal.aborted && allowed())
    void sdk
      .mirrorAttachments(accepted.blobs, signal, allowed)
      .then((ok) => {
        if (!ok && !signal.aborted && allowed()) mirrorFailed();
      })
      .catch(() => {
        if (!signal.aborted && allowed()) mirrorFailed();
      });
}
