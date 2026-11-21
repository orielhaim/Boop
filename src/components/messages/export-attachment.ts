import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { saveToLibraryAsync } from "expo-media-library/legacy";
import { shareAsync } from "expo-sharing";
import { AppState, Platform } from "react-native";
import { removeMediaFile } from "@/core/media/files";
import {
  localAttachmentName,
  type AttachmentMetadata,
} from "@/core/media/protocol";
import type { AttachmentMedia } from "@/core/media/service";

function waitForPickerReturn() {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      subscription.remove();
      clearTimeout(timeout);
      resolve();
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") finish();
    });
    const timeout = setTimeout(finish, 3_000);
    if (AppState.currentState === "active") finish();
  });
}

export async function exportAttachment(
  media: AttachmentMedia,
  peer: string,
  id: string,
  file: AttachmentMetadata,
  action: "share" | "save" | "open",
  valid: () => boolean,
) {
  if (!valid()) return;
  const saveToPhotos =
    action === "save" && ["image", "video", "round-video"].includes(file.kind);
  let destination: Directory | undefined;
  if (action === "save" && !saveToPhotos && Platform.OS === "android") {
    try {
      destination = await Directory.pickDirectoryAsync();
      await waitForPickerReturn();
    } catch {
      return;
    }
  }
  if (!valid()) return;
  const lease = await media.preparePlayback(
    peer,
    id,
    new AbortController().signal,
  );
  const exportDir = new Directory(
    Paths.cache,
    "attachment-exports",
    randomUUID(),
  );
  let shared = false;
  try {
    if (!valid()) return;
    exportDir.create({ intermediates: true });
    const output = new File(exportDir, localAttachmentName(file));
    await new File(lease.uri).copy(output);
    if (!valid()) return;
    if (destination) {
      await output.copy(destination);
      return "saved";
    }
    if (saveToPhotos) {
      await saveToLibraryAsync(output.uri);
      return "saved";
    }
    if (action === "open" && Platform.OS === "android") {
      const { startActivityAsync } = await import("expo-intent-launcher");
      await startActivityAsync("android.intent.action.VIEW", {
        data: output.contentUri,
        type: file.mime,
        flags: 1,
      });
    } else {
      await shareAsync(output.uri, {
        mimeType: file.mime,
        dialogTitle: file.filename,
      });
      shared = Platform.OS === "android";
    }
  } finally {
    lease.dispose();
    if (shared) setTimeout(() => removeMediaFile(exportDir), 60_000);
    else removeMediaFile(exportDir);
  }
}
