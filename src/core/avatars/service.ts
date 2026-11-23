import { asc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { contactByKey, preference } from "@/db/queries";
import { avatarCache, contacts, nostrProfiles } from "@/db/schema";
import type * as schema from "@/db/schema";
import type { Privacy } from "../privacy";
import { cacheEvictions } from "../media/cache-policy";
import {
  blossomHash,
  parseProfile,
  photoAllowed,
  profileDetails,
  publicImageUrl,
  replaces,
} from "./protocol";

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
  removeCached(name: string): void;
  removeLocal(name: string): void;
  sweep(cacheFiles: Set<string>, localFiles: Set<string>): void;
  clearCache(): void;
};

const day = 86_400_000;
const maxVisibleAuthors = 32;
const maxDownloads = 3;
const maxAttemptsPerSource = 6;
const maxDiskBytes = 64 * 1024 * 1024;
const maxDiskRecords = 512;
const filenamePattern = /^[a-f0-9-]{36}\.jpg$/u;

type ProfileRelays = {
  watchProfiles(
    authors: string[],
    onEvent: (event: unknown, author: string) => void,
    onEose: () => void,
  ): (() => void) | null;
};

export function createAvatars<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  owner: string,
  privacy: Pick<Privacy, "photoPolicy" | "isBlocked" | "isContact">,
  relays: ProfileRelays,
  disk: AvatarDisk,
  native: AvatarTransport | null,
  mirrorOrigins: ((from: string) => string[]) | undefined,
  isCurrent: () => boolean,
) {
  const visible = new Map<string, number>();
  const exceptions = new Map<string, number>();
  const jobs = new Map<string, { id: string; source: string }>();
  const failures = new Map<
    string,
    { source: string; count: number; until: number }
  >();
  const listeners = new Map<string, Set<() => void>>();
  let stopWatch: (() => void) | null = null;
  let watchKeys = "";
  let watchStarted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
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
  const profile = (key: string) =>
    db
      .select()
      .from(nostrProfiles)
      .where(eq(nostrProfiles.publicKey, key))
      .get();
  const sourceFor = (key: string) =>
    banner(key)
      ? profileDetails(profile(author(key))?.fields).banner
      : profile(key)?.picture;
  const cached = (key: string) =>
    db.select().from(avatarCache).where(eq(avatarCache.publicKey, key)).get();

  function changed(key: string) {
    for (const listener of listeners.get(author(key)) ?? []) listener();
  }
  function schedule(delay = 100) {
    if (!active) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }
  function invalidate() {
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
  function prune(sweep = false) {
    const rows = db
      .select()
      .from(avatarCache)
      .orderBy(asc(avatarCache.accessedAt))
      .all();
    const { evict } = cacheEvictions(rows, {
      maxBytes: maxDiskBytes,
      maxEntries: maxDiskRecords,
      expiresBefore: Date.now() - 60 * day,
    });
    for (const row of evict) {
      db.delete(avatarCache)
        .where(eq(avatarCache.publicKey, row.publicKey))
        .run();
      disk.removeCached(row.filename);
      changed(row.publicKey);
    }
    if (!sweep) return;
    const cacheFiles = new Set(
      db
        .select({ filename: avatarCache.filename })
        .from(avatarCache)
        .all()
        .map((row) => row.filename),
    );
    const localFiles = new Set(
      db
        .select({ filename: contacts.localAvatarFile })
        .from(contacts)
        .all()
        .flatMap((row) => row.filename ?? []),
    );
    for (const key of [
      "profile.photo",
      "profile.draft.file",
      "profile.banner",
      "profile.draft.banner",
    ]) {
      const value = preference(db, key);
      if (value) localFiles.add(value);
    }
    disk.sweep(cacheFiles, localFiles);
  }
  function ingest(input: unknown, key: string) {
    if (!isCurrent()) return;
    const candidate = parseProfile(input, key);
    if (!candidate || !replaces(candidate, profile(key))) return;
    const values = {
      ...candidate,
      name: candidate.name ?? null,
    };
    db.insert(nostrProfiles)
      .values({ publicKey: key, ...values })
      .onConflictDoUpdate({ target: nostrProfiles.publicKey, set: values })
      .run();
    for (const media of [key, `${key}:banner`]) {
      const job = jobs.get(media);
      if (job && sourceFor(media) !== job.source) {
        jobs.delete(media);
        native?.cancel(job.id);
      }
    }
    changed(key);
    schedule();
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
      const previous = cached(key);
      const values = {
        sourceUrl: source,
        filename,
        size,
        fetchedAt: Date.now(),
        accessedAt: Date.now(),
      };
      db.insert(avatarCache)
        .values({ publicKey: key, ...values })
        .onConflictDoUpdate({ target: avatarCache.publicKey, set: values })
        .run();
      retained = true;
      failures.delete(key);
      changed(key);
      if (previous) disk.removeCached(previous.filename);
      prune();
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
        prune(true);
      } catch {}
    }
    const keys = [...visible.keys()]
      .reverse()
      .filter((key) => !privacy.isBlocked(author(key)))
      .slice(0, maxVisibleAuthors);
    const authors = [...new Set(keys.map(author))].sort();
    const nextWatch = authors.join(",");
    if (watchKeys !== nextWatch || Date.now() - watchStarted > 15 * 60_000) {
      stopWatch?.();
      let valid = true;
      watchKeys = nextWatch;
      watchStarted = Date.now();
      const stop = authors.length
        ? relays.watchProfiles(
            authors,
            (event, author) => {
              if (
                valid &&
                active &&
                (visible.has(author) || visible.has(`${author}:banner`)) &&
                authors.includes(author) &&
                !privacy.isBlocked(author)
              )
                ingest(event, author);
            },
            () => undefined,
          )
        : null;
      stopWatch =
        stop &&
        (() => {
          valid = false;
          stop();
        });
      if (authors.length && !stopWatch) watchKeys = "";
    }
    const now = Date.now();
    if (now >= pausedUntil && native)
      for (const key of keys) {
        if (running >= maxDownloads) break;
        if (jobs.has(key) || !permitted(key) || override(key)) continue;
        const source = sourceFor(key);
        if (!source) continue;
        const copy = cached(key);
        const oldUrl = copy && publicImageUrl(copy.sourceUrl);
        const newUrl = publicImageUrl(source);
        const hash = newUrl && blossomHash(newUrl);
        const sameBlob = hash && oldUrl && blossomHash(oldUrl) === hash;
        if (
          copy &&
          (copy.sourceUrl === source || sameBlob) &&
          disk.cached(copy.filename) &&
          now - copy.fetchedAt < 7 * day
        ) {
          if (now - copy.accessedAt > day) {
            db.update(avatarCache)
              .set({ accessedAt: now })
              .where(eq(avatarCache.publicKey, key))
              .run();
          }
          continue;
        }
        const failure = failures.get(key);
        if (
          failure?.source === source &&
          (failure.until > now || failure.count >= maxAttemptsPerSource)
        )
          continue;
        void fetchPhoto(key, source);
      }
    if (keys.length) schedule(stopWatch ? 30_000 : 5_000);
  }
  function watch(key: string, wide = false) {
    if (!/^[a-f0-9]{64}$/u.test(key)) return () => {};
    const media = wide ? `${key}:banner` : key;
    visible.set(media, (visible.get(media) ?? 0) + 1);
    schedule();
    return () => {
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
    profile,
    ingest,
    invalidate,
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      if (!active) {
        exceptions.clear();
        stopWatch?.();
        stopWatch = null;
        watchKeys = "";
        clearTimeout(timer);
      }
      invalidate();
    },
    refreshRelays() {
      watchKeys = "";
      schedule();
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
      const setting = wide ? "profile.banner" : "profile.photo";
      const manual = peer === owner ? preference(db, setting) : null;
      const uri =
        manual &&
        filenamePattern.test(manual) &&
        preference(db, `${setting}.url`) === sourceFor(key)
          ? disk.local(manual)
          : override(key);
      if (uri) return uri;
      const source = sourceFor(key);
      if (!permitted(key) || !source) return undefined;
      const copy = cached(key);
      if (!copy) return undefined;
      return disk.cached(copy.filename);
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
    notify: changed,
    clear() {
      pausedUntil = Date.now() + 30_000;
      for (const job of jobs.values()) native?.cancel(job.id);
      jobs.clear();
      failures.clear();
      db.delete(avatarCache).run();
      try {
        disk.clearCache();
      } finally {
        invalidate();
      }
    },
  };
}
