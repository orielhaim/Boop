import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { downloadNip05 } from "../media/download-native";
import { removeMediaFile } from "../media/files";
import { nip05Address, nip05Key } from "./nip05";

export function createNip05Lookup(active: () => boolean) {
  const cache = new Map<string, { key: string | null; until: number }>();
  const pending = new Map<
    string,
    {
      result: Promise<string | null>;
      controller: AbortController;
      readers: number;
    }
  >();
  async function fetchMapping(
    address: NonNullable<ReturnType<typeof nip05Address>>,
    signal: AbortSignal,
  ) {
    const directory = new Directory(Paths.cache, "link-previews");
    const id = randomUUID();
    const file = new File(directory, `${id}.bin`);
    try {
      directory.create({ idempotent: true, intermediates: true });
      await downloadNip05(id, address.url, file.uri, signal);
      if (!active() || signal.aborted) throw new Error("Lookup cancelled");
      return nip05Key(JSON.parse(await file.text()), address.name);
    } finally {
      removeMediaFile(file);
    }
  }
  function start(address: NonNullable<ReturnType<typeof nip05Address>>) {
    if (pending.size >= 6) throw new Error("Lookup busy");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const result = fetchMapping(address, controller.signal)
      .then((key) => {
        if (cache.size >= 128) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(address.url, {
          key,
          until: Date.now() + (key ? 3_600_000 : 60_000),
        });
        return key;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (pending.get(address.url)?.controller === controller)
          pending.delete(address.url);
      });
    const request = { result, controller, readers: 0 };
    pending.set(address.url, request);
    return request;
  }
  return {
    async resolve(input: string, signal?: AbortSignal) {
      const address = nip05Address(input);
      if (!address || !active() || signal?.aborted) return null;
      const saved = cache.get(address.url);
      if (saved && saved.until > Date.now()) return saved.key;
      const request = pending.get(address.url) ?? start(address);
      request.readers++;
      let watching = true;
      const leave = () => {
        if (!watching) return;
        watching = false;
        request.readers--;
        if (!request.readers && pending.get(address.url) === request) {
          pending.delete(address.url);
          request.controller.abort();
        }
      };
      signal?.addEventListener("abort", leave, { once: true });
      try {
        const key = await request.result;
        return !active() || signal?.aborted ? null : key;
      } finally {
        signal?.removeEventListener("abort", leave);
        leave();
      }
    },
  };
}
