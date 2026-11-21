import { FileMode, type File } from "expo-file-system";
import { validateAttachment } from "./attachment-format";
import type { MediaFormatInput } from "./format-input";
import type { AttachmentMetadata } from "./protocol";

export function validateAttachmentFile(
  file: File,
  metadata: AttachmentMetadata,
) {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const size = handle.size ?? 0;
    let start = -1;
    let page = new Uint8Array(0);
    const input: MediaFormatInput = {
      size,
      read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > size)
          throw new Error("media-format");
        if (offset < start || offset + length > start + page.length) {
          start = offset;
          handle.offset = start;
          page = handle.readBytesSync(Math.min(4096, size - start));
          if (page.length < length) throw new Error("media-format");
        }
        return page.subarray(offset - start, offset - start + length);
      },
    };
    validateAttachment(input, metadata);
  } finally {
    handle.close();
  }
}
