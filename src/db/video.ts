import { z } from "zod";
import { createMediaPersistence } from "./audio";

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
