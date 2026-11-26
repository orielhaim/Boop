import { File } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { Platform } from "react-native";

type LocalAttachment = {
  path: string;
  type: string;
  name: string;
  lease?: string;
};

export function localMediaUri(path: string) {
  if (!path.startsWith("/")) throw new Error("InvalidMediaPath");
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export async function openLocalAttachment(
  file: LocalAttachment,
  excludeBoop = false,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (Platform.OS === "android" && file.lease) {
    const { marmot } = await import("../marmot/native");
    signal?.throwIfAborted();
    await marmot.handoffAttachment(file.lease, false, excludeBoop);
    return;
  }
  const source = new File(localMediaUri(file.path));
  if (Platform.OS === "android") {
    const { startActivityAsync } = await import("expo-intent-launcher");
    signal?.throwIfAborted();
    try {
      await startActivityAsync("android.intent.action.VIEW", {
        data: source.contentUri,
        type: file.type,
        flags: 1,
        excludeCurrentActivity: excludeBoop,
      });
      return;
    } catch {
      // Offer the system sheet when no activity handles this MIME type.
    }
  }
  signal?.throwIfAborted();
  await shareLocalAttachment(file, signal);
}

export async function shareLocalAttachment(
  file: LocalAttachment,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (Platform.OS === "android" && file.lease) {
    const { marmot } = await import("../marmot/native");
    signal?.throwIfAborted();
    await marmot.handoffAttachment(file.lease, true, false);
    return;
  }
  await shareAsync(localMediaUri(file.path), {
    mimeType: file.type,
    dialogTitle: file.name,
  });
}
