import type { PickedAttachment } from "@kesha-antonov/react-native-chat";
import { Directory, File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { createVideoPlayer } from "expo-video";
import { validateVideo } from "./audio-format";
import { removeMediaFile } from "./files";
import {
  type AttachmentMetadata,
  attachmentMetadata,
  byteLimit,
} from "./protocol";

const longestPhotoSide = 2560;
type Selection = Exclude<PickedAttachment, { type: "location" }>;

export function localPickerUri(uri: string) {
  return /^file:\/\/\/(?!\/)/u.test(uri);
}

export function discardPickedAttachment(uri: string) {
  if (!localPickerUri(uri)) return;
  const file = new File(uri);
  for (const directory of ["ImagePicker", "DocumentPicker"]) {
    const prefix = `${new Directory(Paths.cache, directory).uri.replace(/\/$/u, "")}/`;
    if (
      file.uri.startsWith(prefix) &&
      !file.uri.slice(prefix.length).includes("/")
    ) {
      removeMediaFile(file);
      return;
    }
  }
}

function cleanFilename(name: string) {
  return name
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_")
    .trim()
    .slice(0, 160);
}

export async function preparePickedAttachment(
  item: Selection,
  caption: string,
  round = false,
) {
  if (!localPickerUri(item.uri)) throw new Error("media-format");
  const source = new File(item.uri);
  const kind = round ? "round-video" : item.type;
  if (!source.size) throw new Error("media-format");
  if (source.size > byteLimit(kind) - 16) throw new Error("media-size");
  let temp: File | undefined;
  try {
    let metadata: AttachmentMetadata;
    if (item.type === "image") {
      const image = await Image.loadAsync(
        { uri: item.uri },
        { maxWidth: longestPhotoSide, maxHeight: longestPhotoSide },
      );
      try {
        if (image.width <= 0 || image.height <= 0)
          throw new Error("media-format");
        const png =
          (item.mimeType === "image/png" ||
            source.extension.toLowerCase() === ".png") &&
          source.size <= 4 * 1024 * 1024;
        const editor = ImageManipulator.manipulate(image);
        try {
          const rendered = await editor.renderAsync();
          try {
            const result = await rendered.saveAsync({
              format: png ? SaveFormat.PNG : SaveFormat.JPEG,
              compress: source.size <= 512 * 1024 ? 0.98 : 0.89,
            });
            temp = new File(result.uri);
            metadata = {
              kind,
              mime: png ? "image/png" : "image/jpeg",
              dimensions: { width: result.width, height: result.height },
              thumbhash: await Image.generateThumbhashAsync(result.uri).catch(
                () => undefined,
              ),
            };
          } finally {
            rendered.release();
          }
        } finally {
          editor.release();
        }
      } finally {
        image.release();
      }
    } else if (item.type === "video") {
      validateVideo(await source.bytes());
      const player = createVideoPlayer(null);
      let preview: string | undefined;
      let duration = item.duration;
      try {
        await player.replaceAsync({ uri: item.uri, useCaching: false });
        const frames = await player.generateThumbnailsAsync([0.2, 0], {
          maxWidth: 96,
          maxHeight: 96,
        });
        try {
          if (frames[0]) {
            const editor = ImageManipulator.manipulate(frames[0]);
            try {
              const bitmap = await editor.renderAsync();
              try {
                const saved = await bitmap.saveAsync({
                  format: SaveFormat.JPEG,
                });
                try {
                  preview = await Image.generateThumbhashAsync(saved.uri);
                } finally {
                  removeMediaFile(new File(saved.uri));
                }
              } finally {
                bitmap.release();
              }
            } finally {
              editor.release();
            }
          }
        } finally {
          for (const frame of frames) frame.release();
        }
        duration ||= player.duration;
      } catch {
        // A locally readable clip can be sent with a neutral poster.
      } finally {
        player.release();
      }
      const dimensions =
        item.width && item.height && item.width <= 8192 && item.height <= 8192
          ? { width: item.width, height: item.height }
          : undefined;
      metadata = {
        kind,
        mime:
          source.extension.toLowerCase() === ".mov"
            ? "video/quicktime"
            : "video/mp4",
        durationMs:
          duration && duration > 0 ? Math.round(duration * 1000) : undefined,
        dimensions,
        thumbhash: preview,
      };
    } else {
      const normalized = item.mimeType?.toLowerCase().split(";")[0].trim();
      const mime =
        normalized &&
        /^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/u.test(normalized) &&
        normalized.length <= 120
          ? normalized
          : "application/octet-stream";
      metadata = {
        kind,
        mime,
        filename: cleanFilename(item.name) || undefined,
      };
    }
    return {
      uri: temp?.uri ?? item.uri,
      metadata: attachmentMetadata.parse({
        ...metadata,
        caption: caption.trim().slice(0, 2000) || undefined,
      }),
      dispose() {
        if (temp) removeMediaFile(temp);
      },
    };
  } catch (error) {
    if (temp) removeMediaFile(temp);
    throw error;
  }
}
