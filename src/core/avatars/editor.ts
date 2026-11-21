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
  watchProfiles(
    keys: string[],
    onEvent: (event: unknown, author: string) => void,
    onEose: () => void,
  ): (() => void) | null;
  publishProfile(content: string, createdAt: number): Promise<unknown>;
};

const fileName = z.string().regex(/^[a-f0-9-]{36}\.jpg$/u);
const draftSchema = z.object({
  photo: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unchanged") }),
    z.object({ kind: z.literal("remove") }),
    z.object({
      kind: z.literal("upload"),
      file: fileName,
      url: z.string().optional(),
      mirrorFailed: z.boolean().optional(),
    }),
  ]),
  name: z.string().max(128).optional(),
});
type Draft = z.infer<typeof draftSchema>;
type ProfileStage = "idle" | "uploading" | "publishing";

export function createProfileEditor<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  owner: string,
  avatars: Pick<Avatars, "profile" | "ingest" | "notify">,
  disk: Pick<AvatarDisk, "newId" | "local" | "copyLocal" | "removeLocal">,
  upload: (file: string, signal: AbortSignal) => Promise<MediaUploadResult>,
  relays: Relays,
) {
  const listeners = new Set<() => void>();
  let revision = 0;
  let stage: ProfileStage = "idle";
  let abort: AbortController | undefined;
  let lastTimestamp = 0;
  const notify = () => {
    revision++;
    for (const listener of listeners) listener();
    avatars.notify(owner);
  };
  const pinned = () => preference(db, "identity.publicKey") === owner;
  const readDraft = () => {
    try {
      return draftSchema.parse(
        JSON.parse(preference(db, "profile.draft") ?? "null"),
      );
    } catch {
      return null;
    }
  };
  function remove(filename: string | null) {
    if (!filename || !fileName.safeParse(filename).success) return;
    disk.removeLocal(filename);
  }
  function write(draft: Draft | null) {
    db.transaction((tx) => {
      setPreference(tx, "profile.draft", draft ? JSON.stringify(draft) : "");
      setPreference(
        tx,
        "profile.draft.file",
        draft?.photo.kind === "upload" ? draft.photo.file : "",
      );
    });
    notify();
  }
  function edit(photo: Draft["photo"], name?: string) {
    if (!pinned() || abort) throw new Error("Profile editor unavailable");
    const previous = readDraft();
    write({ photo, name });
    if (
      previous?.photo.kind === "upload" &&
      (photo.kind !== "upload" || photo.file !== previous.photo.file)
    )
      remove(previous.photo.file);
  }
  function refresh(signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      let stop: (() => void) | null = null;
      let invalid: { eventId: string; createdAt: number } | undefined;
      const timer = setTimeout(() => finish(false), 7_000);
      const cancel = () => finish(false);
      function finish(complete: boolean) {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        stop?.();
        resolve(
          complete &&
            (!invalid ||
              replaces(
                avatars.profile(owner) ?? { eventId: "", createdAt: 0 },
                invalid,
              )),
        );
      }
      signal.addEventListener("abort", cancel, { once: true });
      stop = relays.watchProfiles(
        [owner],
        (event, author) => {
          if (author !== owner || !pinned() || signal.aborted) return;
          if (parseProfile(event, owner)) {
            avatars.ingest(event, owner);
            return;
          }
          const verified = verifiedEvent(event);
          if (verified?.kind !== 0 || verified.pubkey !== owner) return;
          const candidate = {
            eventId: verified.id,
            createdAt: verified.created_at,
          };
          if (replaces(candidate, invalid)) invalid = candidate;
        },
        () => finish(true),
      );
      if (!stop || signal.aborted) finish(false);
    });
  }
  return {
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stage: () => stage,
    draft: readDraft,
    preview() {
      const draft = readDraft();
      if (draft?.photo.kind !== "upload") return;
      return disk.local(draft.photo.file);
    },
    prepare(source: string, name?: string) {
      if (!pinned() || abort) throw new Error("Profile editor unavailable");
      const file = `${disk.newId()}.jpg`;
      disk.copyLocal(source, file);
      try {
        edit({ kind: "upload", file }, name);
      } catch (error) {
        remove(file);
        throw error;
      }
    },
    removePhoto(name?: string) {
      edit({ kind: "remove" }, name);
    },
    editName(name: string) {
      edit(readDraft()?.photo ?? { kind: "unchanged" }, name);
    },
    discard() {
      const draft = readDraft();
      if (abort) return;
      write(null);
      if (draft?.photo.kind === "upload") remove(draft.photo.file);
    },
    cancel() {
      abort?.abort();
    },
    async publish() {
      const saved = readDraft();
      if (!saved || abort || !pinned()) return "unavailable";
      let draft: Draft = saved;
      const job = new AbortController();
      abort = job;
      const { signal } = job;
      const valid = () => pinned() && !signal.aborted;
      try {
        stage =
          draft.photo.kind === "upload" && !draft.photo.url
            ? "uploading"
            : "publishing";
        notify();
        if (draft.photo.kind === "upload" && !draft.photo.url) {
          const file = draft.photo.file;
          const { url, mirror } = await upload(file, signal);
          if (!valid()) return "cancelled";
          draft = { ...draft, photo: { ...draft.photo, url } };
          write(draft);
          if (mirror && !(await mirror)) {
            if (!valid()) return "cancelled";
            draft = {
              ...draft,
              photo: { kind: "upload", file, url, mirrorFailed: true },
            };
            write(draft);
          }
        }
        if (!(await refresh(signal)))
          return signal.aborted ? "cancelled" : "relays";
        if (!valid()) return "cancelled";
        const previous = avatars.profile(owner);
        const photoEdits =
          draft.photo.kind === "upload" ? draft.photo.url : null;
        if (
          draft.photo.kind === "upload" &&
          (!photoEdits || !publicImageUrl(photoEdits))
        )
          return "unavailable";
        const content = JSON.stringify(
          updateProfileFields(previous?.fields, {
            displayName: draft.name,
            picture: draft.photo.kind === "unchanged" ? undefined : photoEdits,
          }),
        );
        if (new TextEncoder().encode(content).length > maxProfileBytes)
          return "metadata";
        const now = Math.floor(Date.now() / 1000);
        const timestamp = Math.max(
          now,
          (previous?.createdAt ?? 0) + 1,
          lastTimestamp + 1,
        );
        if (timestamp > now + 60 || !valid()) return "relays";
        lastTimestamp = timestamp;
        stage = "publishing";
        notify();
        const result = await relays.publishProfile(content, timestamp);
        if (!result || !pinned()) return "relays";
        // A relay can acknowledge after cancellation, so reconcile that publication.
        avatars.ingest(result, owner);
        const oldPhoto = preference(db, "profile.photo");
        const photo = draft.photo;
        db.transaction((tx) => {
          if (photo.kind !== "unchanged") {
            setPreference(
              tx,
              "profile.photo",
              photo.kind === "upload" ? photo.file : "",
            );
            setPreference(
              tx,
              "profile.photo.url",
              photo.kind === "upload" ? (photo.url ?? "") : "",
            );
          }
          setPreference(tx, "profile.draft", "");
          setPreference(tx, "profile.draft.file", "");
        });
        if (
          photo.kind !== "unchanged" &&
          oldPhoto !== (photo.kind === "upload" ? photo.file : null)
        )
          remove(oldPhoto);
        return photo.kind === "upload" && photo.mirrorFailed
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
