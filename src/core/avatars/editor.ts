import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type * as schema from "@/db/schema";
import { preference, setPreference } from "@/db/queries";
import type { MediaUploadResult } from "../media/uploads";
import {
  maxProfileBytes,
  parseProfile,
  publicImageUrl,
  replaces,
  updateProfileFields,
} from "./protocol";
import { verifiedEvent } from "../nostr/gift-wrap";
import type { AvatarDisk, createAvatars } from "./service";

type Avatars = ReturnType<typeof createAvatars>;
type Relays = {
  watchOwnProfile(
    onEvent: (event: unknown, author: string) => void,
    onEose: (allReplied: boolean) => void,
  ): (() => void) | null;
  publishProfile(content: string, createdAt: number): Promise<unknown>;
};

const fileName = z.string().regex(/^[a-f0-9-]{36}\.jpg$/u);
const imageEdit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged") }),
  z.object({ kind: z.literal("remove") }),
  z.object({
    kind: z.literal("upload"),
    file: fileName,
    url: z.string().optional(),
    mirrorFailed: z.boolean().optional(),
  }),
]);
const draftSchema = z.object({
  photo: imageEdit,
  banner: imageEdit.optional(),
  about: z.string().max(1000).optional(),
  website: z.string().max(2048).optional(),
  nip05: z.string().max(254).optional(),
  name: z.string().max(128).optional(),
});
type Draft = z.infer<typeof draftSchema>;
type ProfileStage = "idle" | "uploading" | "publishing";

export function createProfileEditor<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  owner: string,
  avatars: Pick<Avatars, "profile" | "ingest" | "notify">,
  disk: Pick<AvatarDisk, "newId" | "local" | "copyLocal" | "removeLocal">,
  upload: (
    file: string,
    signal: AbortSignal,
    wide: boolean,
  ) => Promise<MediaUploadResult>,
  relays: Relays,
  isCurrent: () => boolean,
  canPublish: () => Promise<boolean>,
) {
  const listeners = new Set<() => void>();
  let stage: ProfileStage = "idle";
  let abort: AbortController | undefined;
  let editRevision = 0;

  const readDraft = () => {
    try {
      return draftSchema.parse(
        JSON.parse(preference(db, "profile.draft") ?? "null"),
      );
    } catch {
      return null;
    }
  };
  function makeSnapshot() {
    const draft = readDraft();
    return {
      draft,
      stage,
      editRevision,
      bannerPreview:
        draft?.banner?.kind === "upload"
          ? disk.local(draft.banner.file)
          : undefined,
      photoPreview:
        draft?.photo.kind === "upload"
          ? disk.local(draft.photo.file)
          : undefined,
    };
  }
  let snapshot = makeSnapshot();
  function notify() {
    snapshot = makeSnapshot();
    for (const listener of listeners) listener();
    avatars.notify(owner);
  }
  function remove(filename: string | null) {
    if (!filename || !fileName.safeParse(filename).success) return;
    disk.removeLocal(filename);
  }
  function write(draft: Draft | null) {
    db.transaction((tx) => {
      setPreference(tx, "profile.draft", draft ? JSON.stringify(draft) : "");
      setPreference(
        tx,
        "profile.draft.banner",
        draft?.banner?.kind === "upload" ? draft.banner.file : "",
      );
      setPreference(
        tx,
        "profile.draft.file",
        draft?.photo.kind === "upload" ? draft.photo.file : "",
      );
    });
    notify();
  }
  function writeEdit(draft: Draft) {
    if (!isCurrent()) throw new Error("Profile editor unavailable");
    editRevision++;
    write(draft);
    abort?.abort();
  }
  function refresh(signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      let stop: (() => void) | null = null;
      let invalid: { eventId: string; createdAt: number } | undefined;
      let finished = false;
      let answered = false;
      const timer = setTimeout(finish, 2_000);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        stop?.();
        const cached = avatars.profile(owner);
        resolve(
          !signal.aborted &&
            (answered || Boolean(cached)) &&
            (!invalid || (cached !== undefined && replaces(cached, invalid))),
        );
      }
      signal.addEventListener("abort", finish, { once: true });
      stop = relays.watchOwnProfile(
        (event, author) => {
          if (author !== owner || !isCurrent() || signal.aborted) return;
          if (parseProfile(event, owner)) {
            avatars.ingest(event, owner);
            return;
          }
          const verified = verifiedEvent(event);
          if (
            verified?.kind !== 0 ||
            verified.pubkey !== owner ||
            verified.created_at > Math.floor(Date.now() / 1000) + 60
          )
            return;
          const candidate = {
            eventId: verified.id,
            createdAt: verified.created_at,
          };
          if (replaces(candidate, invalid)) invalid = candidate;
        },
        (allReplied) => {
          answered = true;
          if (allReplied) finish();
        },
      );
      if (finished) stop?.();
      else if (!stop || signal.aborted) finish();
    });
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    draft: readDraft,
    preview(field: "photo" | "banner" = "photo") {
      const image = readDraft()?.[field];
      if (image?.kind === "upload") return disk.local(image.file);
    },
    prepare(source: string, field: "photo" | "banner" = "photo") {
      if (!isCurrent()) throw new Error("Profile editor unavailable");
      const file = `${disk.newId()}.jpg`;
      disk.copyLocal(source, file);
      try {
        const previous = readDraft();
        writeEdit({
          photo: { kind: "unchanged" },
          ...previous,
          [field]: { kind: "upload", file },
        });
        const old = previous?.[field];
        if (old?.kind === "upload") remove(old.file);
      } catch (error) {
        remove(file);
        throw error;
      }
    },
    removeImage(field: "photo" | "banner") {
      const previous = readDraft();
      writeEdit({
        photo: { kind: "unchanged" },
        ...previous,
        [field]: { kind: "remove" },
      });
      const old = previous?.[field];
      if (old?.kind === "upload") remove(old.file);
    },
    editFields(fields: Pick<Draft, "name" | "about" | "website" | "nip05">) {
      writeEdit(
        draftSchema.parse({
          photo: { kind: "unchanged" },
          ...readDraft(),
          ...fields,
        }),
      );
    },
    discard() {
      const draft = readDraft();
      if (abort) return;
      write(null);
      if (draft?.photo.kind === "upload") remove(draft.photo.file);
      if (draft?.banner?.kind === "upload") remove(draft.banner.file);
    },
    cancel() {
      abort?.abort();
    },
    async publish() {
      const saved = readDraft();
      if (!saved || abort || !isCurrent()) return "unavailable";
      let draft: Draft = saved;
      const job = new AbortController();
      abort = job;
      const { signal } = job;
      const valid = () => isCurrent() && !signal.aborted;
      try {
        if (!(await canPublish())) return "relays";
        if (!valid()) return "cancelled";
        for (const field of ["photo", "banner"] as const) {
          const image = draft[field];
          if (image?.kind !== "upload" || image.url) continue;
          stage = "uploading";
          notify();
          const { url, mirror } = await upload(
            image.file,
            signal,
            field === "banner",
          );
          if (!valid()) return "cancelled";
          if (!publicImageUrl(url)) return "metadata";
          draft = { ...draft, [field]: { ...image, url } };
          write(draft);
          if (mirror) {
            const mirrored = await mirror.catch(() => false);
            if (!valid()) return "cancelled";
            if (!mirrored) {
              draft = {
                ...draft,
                [field]: { ...image, url, mirrorFailed: true },
              };
              write(draft);
            }
          }
        }
        stage = "publishing";
        notify();
        if (!(await refresh(signal)))
          return signal.aborted ? "cancelled" : "relays";
        if (!valid()) return "cancelled";
        const previous = avatars.profile(owner);
        const imageUrl = (image: Draft["banner"]) =>
          image?.kind === "upload"
            ? image.url
            : image?.kind === "remove"
              ? null
              : undefined;
        const content = JSON.stringify(
          updateProfileFields(previous?.fields, {
            displayName: draft.name,
            about: draft.about,
            website: draft.website,
            nip05: draft.nip05,
            picture: imageUrl(draft.photo),
            banner: imageUrl(draft.banner),
          }),
        );
        if (new TextEncoder().encode(content).length > maxProfileBytes)
          return "metadata";
        const now = Math.floor(Date.now() / 1000);
        const priorAttempt = Number(preference(db, "profile.publishAt") || 0);
        const same = preference(db, "profile.publishContent") === content;
        const acknowledged =
          previous &&
          JSON.stringify(previous.fields) === content &&
          same &&
          previous.createdAt >= priorAttempt;
        if (!acknowledged) {
          const timestamp =
            same && priorAttempt > (previous?.createdAt ?? 0)
              ? priorAttempt
              : Math.max(now, (previous?.createdAt ?? 0) + 1, priorAttempt + 1);
          if (timestamp > now + 60 || !valid()) return "relays";
          db.transaction((tx) => {
            setPreference(tx, "profile.publishAt", String(timestamp));
            setPreference(tx, "profile.publishContent", content);
          });
          const result = await relays.publishProfile(content, timestamp);
          if (!valid()) return "cancelled";
          const published = parseProfile(result, owner);
          if (!published) return "relays";
          avatars.ingest(result, owner);
          if (avatars.profile(owner)?.eventId !== published.eventId)
            return "relays";
        }
        const retired: string[] = [];
        db.transaction((tx) => {
          for (const field of ["photo", "banner"] as const) {
            const image = draft[field];
            if (!image || image.kind === "unchanged") continue;
            const setting = `profile.${field}`;
            const old = preference(tx, setting);
            const next = image.kind === "upload" ? image.file : "";
            if (old && old !== next) retired.push(old);
            setPreference(tx, setting, next);
            setPreference(tx, `${setting}.url`, imageUrl(image) ?? "");
          }
          for (const key of [
            "profile.draft",
            "profile.draft.file",
            "profile.draft.banner",
            "profile.publishAt",
            "profile.publishContent",
          ])
            setPreference(tx, key, "");
        });
        for (const file of retired) remove(file);
        return [draft.photo, draft.banner].some(
          (image) => image?.kind === "upload" && image.mirrorFailed,
        )
          ? "mirror"
          : "published";
      } finally {
        abort = undefined;
        stage = "idle";
        notify();
      }
    },
  };
}
