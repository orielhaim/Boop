import { z } from "zod";
import { createMediaPersistence } from "./audio";
import {
  captionPositions,
  captionPresets,
  captionSizes,
  defaultCaptionAppearance,
  type CaptionAppearance,
} from "@/core/video/subtitles/types";

export function videoPersistence(
  options: Parameters<typeof createMediaPersistence>[0],
) {
  const cache = createMediaPersistence(
    options,
    "video.positions",
    z.array(z.tuple([z.string(), z.number().finite().positive()])).max(200),
  );
  const positions = new Map(cache.load());
  return {
    get: (id: string) => positions.get(id) ?? 0,
    set(id: string, seconds: number) {
      if ((positions.get(id) ?? 0) === seconds) return;
      positions.delete(id);
      if (seconds > 0) positions.set(id, seconds);
      while (positions.size > 200) {
        const oldest = positions.keys().next();
        if (oldest.done) break;
        positions.delete(oldest.value);
      }
      cache.save([...positions]);
    },
    clear() {
      positions.clear();
      cache.save([]);
    },
  };
}

export function captionPersistence(
  options: Parameters<typeof createMediaPersistence>[0],
) {
  const appearance = createMediaPersistence(
    options,
    "video.captionAppearance",
    z.object({
      preset: z.enum(captionPresets),
      size: z.enum(captionSizes),
      position: z.enum(captionPositions),
    }),
  );
  const timings = createMediaPersistence(
    options,
    "video.captionOffset",
    z
      .array(z.tuple([z.string(), z.number().finite().min(-600).max(600)]))
      .max(200),
  );
  const offsets = new Map(timings.load());
  return {
    appearance: appearance.load() ?? defaultCaptionAppearance,
    saveAppearance(value: CaptionAppearance) {
      appearance.save(value);
    },
    offset: (id: string) => offsets.get(id) ?? 0,
    saveOffset(id: string, offset: number) {
      offsets.delete(id);
      if (offset) offsets.set(id, offset);
      while (offsets.size > 200) {
        const oldest = offsets.keys().next();
        if (oldest.done) break;
        offsets.delete(oldest.value);
      }
      timings.save([...offsets]);
    },
  };
}
