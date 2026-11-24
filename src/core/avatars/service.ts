import { eq } from "drizzle-orm";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { contactByKey } from "@/db/queries";
import { contacts } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { Privacy } from "../privacy";
import { blossomHash, publicMediaUrl as publicImageUrl } from "../media/url";
import { photoAllowed } from "./protocol";
import type { createProfileDirectory } from "../profiles/directory";

export type AvatarTransport = {
  download(
    id: string,
    url: string,
    destination: string,
    hash: string | null,
  ): Promise<number>;
  cancel(id: string): void;
};

export type AvatarDisk = {
  newId(): string;
  cacheTarget(name: string): string;
  cached(name: string): string | undefined;
  local(name: string): string | undefined;
  copyLocal(uri: string, name: string): void;
  authored(field: "photo" | "banner", name: string): string | undefined;
  keepAuthored(
    field: "photo" | "banner",
    file: string | null,
    name?: string,
  ): void;
  removeCached(name: string): void;
  commitCached(staged: string, name: string): void;
  pruneCache(): void;
  removeLocal(name: string): void;
  sweepLocal(localFiles: Set<string>): void;
  clearCache(): void;
};

const day = 86_400_000;
const maxVisibleAuthors = 32;
const maxDownloads = 3;
const maxAttemptsPerSource = 6;
const filenamePattern = /^[a-f0-9-]{36}\.jpg$/u;

export function createAvatars<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  owner: string,
  privacy: Pick<Privacy, "photoPolicy" | "isBlocked" | "isContact">,
  directory: Pick<
    ReturnType<typeof createProfileDirectory>,
    "profile" | "watch" | "subscribe"
  >,
  disk: AvatarDisk,
  native: AvatarTransport | null,
  mirrorOrigins: ((from: string) => string[]) | undefined,
  isCurrent: () => boolean,
  draftFiles: () => string[],
) {
  const visible = new Map<string, number>();
  const exceptions = new Map<string, number>();
  const jobs = new Map<string, { id: string; source: string }>();
  const failures = new Map<
    string,
    { source: string; count: number; until: number }
  >();
  const listeners = new Map<string, Set<() => void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduledAt = 0;
  let active = false;
  let policy = privacy.photoPolicy();
  let initialized = false;
  let pausedUntil = 0;

  const author = (key: string) => key.split(":")[0];
  const banner = (key: string) => key.endsWith(":banner");
  const override = (key: string) => {
    if (banner(key)) return undefined;
    const name = contactByKey(db, key).get()?.localAvatarFile;
    return name && filenamePattern.test(name) ? disk.local(name) : undefined;
  };
  const permitted = (key: string) => {
    const peer = author(key);
    return (
      isCurrent() &&
      !privacy.isBlocked(peer) &&
      (exceptions.has(peer) ||
        photoAllowed(privacy.photoPolicy(), false, privacy.isContact(peer)))
    );
  };
  const sourceFor = (key: string) => {
    const profile = directory.profile(author(key));
    return banner(key) ? profile?.banner : profile?.picture;
  };
  const cacheName = (source: string) =>
    `${bytesToHex(sha256(new TextEncoder().encode(source)))}.jpg`;

  const authored = (key: string, source: string) =>
    author(key) === owner
      ? disk.authored(banner(key) ? "banner" : "photo", cacheName(source))
      : undefined;

  function changed(key: string) {
    for (const listener of listeners.get(author(key)) ?? []) listener();
  }
  function schedule(delay = 100) {
    if (!active) return;
    const at = Date.now() + delay;
    if (timer && scheduledAt <= at) return;
    clearTimeout(timer);
    scheduledAt = at;
    timer = setTimeout(tick, delay);
  }
  function invalidate() {
    const next = privacy.photoPolicy();
    if (policy !== next) {
      policy = next;
      exceptions.clear();
    }
    for (const [key, job] of jobs) {
      if (
        !active ||
        !visible.has(key) ||
        !permitted(key) ||
        override(key) ||
        sourceFor(key) !== job.source
      ) {
        jobs.delete(key);
        native?.cancel(job.id);
      }
    }
    for (const key of listeners.keys()) changed(key);
    schedule();
  }
  function initializeFiles() {
    disk.pruneCache();
    const localFiles = new Set(
      db
        .select({ filename: contacts.localAvatarFile })
        .from(contacts)
        .all()
        .flatMap((row) => row.filename ?? []),
    );
    for (const filename of draftFiles()) localFiles.add(filename);
    disk.sweepLocal(localFiles);
  }
  let running = 0;
  async function fetchPhoto(key: string, source: string) {
    const url = publicImageUrl(source);
    if (
      !native ||
      !url ||
      !active ||
      !visible.has(key) ||
      !permitted(key) ||
      override(key)
    )
      return;
    const id = disk.newId();
    const job = { id, source };
    const filename = `${id}.jpg`;
    const current = () =>
      active &&
      jobs.get(key) === job &&
      permitted(key) &&
      !override(key) &&
      visible.has(key) &&
      sourceFor(key) === source;
    jobs.set(key, job);
    running++;
    let retained = false;
    try {
      const target = disk.cacheTarget(filename);
      const hash = blossomHash(url);
      let size: number;
      try {
        size = await native.download(id, source, target, hash ?? null);
      } catch (error) {
        const mirror =
          hash && current() ? mirrorOrigins?.(url.origin).at(0) : undefined;
        if (!hash || !mirror) throw error;
        job.id = disk.newId();
        size = await native.download(
          job.id,
          new URL(`/${hash}`, mirror).href,
          target,
          hash,
        );
      }
      if (!current()) return;
      if (size <= 0 || size > 2_097_152 || !disk.cached(filename))
        throw new Error("Invalid cached avatar");
      disk.commitCached(filename, cacheName(source));
      retained = true;
      failures.delete(key);
      changed(key);
      disk.pruneCache();
    } catch {
      if (current()) {
        const failure = failures.get(key);
        const count = failure?.source === source ? failure.count + 1 : 1;
        failures.set(key, {
          source,
          count,
          until:
            Date.now() + Math.min(day, 30_000 * 2 ** Math.min(12, count - 1)),
        });
        if (failures.size > 128) {
          const first = failures.keys().next().value;
          if (first) failures.delete(first);
        }
      }
    } finally {
      if (!retained) disk.removeCached(filename);
      if (jobs.get(key) === job) jobs.delete(key);
      running--;
      schedule();
    }
  }
  function tick() {
    timer = undefined;
    if (!active || !isCurrent()) return;
    if (!initialized) {
      initialized = true;
      try {
        initializeFiles();
      } catch {}
    }
    const keys = [...visible.keys()]
      .reverse()
      .filter((key) => !privacy.isBlocked(author(key)))
      .slice(0, maxVisibleAuthors);
    if (!native || !keys.length) return;
    const now = Date.now();
    if (now < pausedUntil) {
      schedule(pausedUntil - now);
      return;
    }
    let retryAt = Infinity;
    for (const key of keys) {
      if (running >= maxDownloads) break;
      if (jobs.has(key) || !permitted(key) || override(key)) continue;
      const source = sourceFor(key);
      if (!source || disk.cached(cacheName(source)) || authored(key, source))
        continue;
      const failure = failures.get(key);
      if (failure?.source === source) {
        if (failure.count >= maxAttemptsPerSource) continue;
        if (failure.until > now) {
          retryAt = Math.min(retryAt, failure.until);
          continue;
        }
      }
      void fetchPhoto(key, source);
    }
    if (Number.isFinite(retryAt)) schedule(retryAt - now);
  }
  function watch(key: string, wide = false) {
    if (!/^[a-f0-9]{64}$/u.test(key)) return () => {};
    const media = wide ? `${key}:banner` : key;
    visible.set(media, (visible.get(media) ?? 0) + 1);
    const stopProfile = directory.watch(key);
    const stopUpdates = directory.subscribe(key, () => invalidate());
    schedule();
    return () => {
      stopProfile();
      stopUpdates();
      const count = visible.get(media) ?? 0;
      if (count <= 1) {
        visible.delete(media);
        const job = jobs.get(media);
        if (job) {
          jobs.delete(media);
          native?.cancel(job.id);
        }
      } else visible.set(media, count - 1);
      schedule();
    };
  }
  return {
    invalidate,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      if (!active) {
        exceptions.clear();
        clearTimeout(timer);
        timer = undefined;
      }
      invalidate();
    },
    watch,
    allowVisit(key: string) {
      if (!active || !isCurrent() || privacy.isBlocked(key)) return () => {};
      exceptions.set(key, (exceptions.get(key) ?? 0) + 1);
      invalidate();
      return () => {
        const count = exceptions.get(key) ?? 0;
        if (count <= 1) exceptions.delete(key);
        else exceptions.set(key, count - 1);
        invalidate();
      };
    },
    autoLoads(key: string) {
      return photoAllowed(
        privacy.photoPolicy(),
        privacy.isBlocked(key),
        privacy.isContact(key),
      );
    },
    subscribe(key: string, listener: () => void) {
      const callbacks = listeners.get(key) ?? new Set();
      callbacks.add(listener);
      listeners.set(key, callbacks);
      return () => {
        callbacks.delete(listener);
        if (!callbacks.size) listeners.delete(key);
      };
    },
    resolve(peer: string, wide = false) {
      if (!peer || !isCurrent() || privacy.isBlocked(peer)) return undefined;
      const key = wide ? `${peer}:banner` : peer;
      const uri = override(key);
      if (uri) return uri;
      const source = sourceFor(key);
      if (!source) return undefined;
      return (
        authored(key, source) ??
        (permitted(key) ? disk.cached(cacheName(source)) : undefined)
      );
    },
    keepUploaded(
      field: "photo" | "banner",
      filename: string | null,
      url?: string,
    ) {
      if (!isCurrent()) return;
      const source = url && publicImageUrl(url);
      if (filename && !source) return;
      disk.keepAuthored(
        field,
        filename,
        source ? cacheName(source.href) : undefined,
      );
      changed(owner);
    },
    hasOverride: (key: string) => Boolean(override(key)),
    saveOverride(key: string, source: string | null) {
      if (!isCurrent() || privacy.isBlocked(key) || !privacy.isContact(key))
        throw new Error("Contact unavailable");
      const previous = contactByKey(db, key).get()?.localAvatarFile;
      const filename = source ? `${disk.newId()}.jpg` : null;
      if (source && filename) disk.copyLocal(source, filename);
      try {
        const contact = db
          .update(contacts)
          .set({ localAvatarFile: filename })
          .where(eq(contacts.publicKey, key))
          .returning({ key: contacts.publicKey })
          .get();
        if (!contact) throw new Error("Contact unavailable");
      } catch (error) {
        if (filename) disk.removeLocal(filename);
        throw error;
      }
      if (previous && filenamePattern.test(previous))
        disk.removeLocal(previous);
      invalidate();
    },
    clear() {
      pausedUntil = Date.now() + 30_000;
      for (const job of jobs.values()) native?.cancel(job.id);
      jobs.clear();
      failures.clear();
      try {
        disk.clearCache();
      } finally {
        invalidate();
      }
    },
  };
}
