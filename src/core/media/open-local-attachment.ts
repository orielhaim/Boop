import { File } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { Platform } from "react-native";

export function localMediaUri(path: string) {
  if (!path.startsWith("/")) throw new Error("InvalidMediaPath");
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export async function openLocalAttachment(
  file: {
    path: string;
    type: string;
    name: string;
  },
  excludeBoop = false,
) {
  const source = new File(localMediaUri(file.path));
  if (Platform.OS === "android") {
    const { startActivityAsync } = await import("expo-intent-launcher");
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
  await shareAsync(source.uri, { mimeType: file.type, dialogTitle: file.name });
}
