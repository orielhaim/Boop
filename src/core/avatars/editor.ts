import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type * as schema from "@/db/schema";
import { preference, setPreference } from "@/db/queries";
import type { MediaUploadResult } from "../media/uploads";
import type { MarmotProfileEdits } from "../marmot/native";
import { publicMediaUrl } from "../media/url";
import type { AvatarDisk } from "./service";

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
  disk: Pick<AvatarDisk, "newId" | "local" | "copyLocal" | "removeLocal">,
  upload: (
    file: string,
    signal: AbortSignal,
    wide: boolean,
  ) => Promise<MediaUploadResult>,
  publishEdits: (
    edits: MarmotProfileEdits,
    signal: AbortSignal,
  ) => Promise<void>,
  keepUploaded: (
    field: "photo" | "banner",
    filename: string | null,
    url?: string,
  ) => void,
  isCurrent: () => boolean,
  canPublish: () => Promise<boolean>,
) {
  const listeners = new Set<() => void>();
  let stage: ProfileStage = "idle";
  let abort: AbortController | undefined;
  let editRevision = 0;
  let active = false;
  let retryDelay = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error = false;

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
      error,
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
  }
  function remove(filename: string | null) {
    if (!filename || !fileName.safeParse(filename).success) return;
    disk.removeLocal(filename);
  }
  function write(draft: Draft | null) {
    setPreference(db, "profile.draft", draft ? JSON.stringify(draft) : "");
    notify();
  }
  function schedule() {
    if (!active || !isCurrent() || !snapshot.draft || abort || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const revision = editRevision;
      void publish()
        .catch(() => "unavailable")
        .then((result) => {
          if (
            revision === editRevision &&
            snapshot.draft &&
            active &&
            result !== "cancelled"
          ) {
            error = true;
            retryDelay = Math.min(Math.max(15_000, retryDelay * 2), 300_000);
            notify();
          }
          schedule();
        });
    }, retryDelay);
  }
  function retry() {
    clearTimeout(timer);
    timer = undefined;
    retryDelay = 0;
    schedule();
  }
  function writeEdit(draft: Draft) {
    if (!isCurrent()) throw new Error("Profile editor unavailable");
    editRevision++;
    error = false;
    write(draft);
    abort?.abort();
    retry();
  }
  async function publish() {
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
        if (!publicMediaUrl(url)) return "metadata";
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
      const edits: MarmotProfileEdits = {};
      if (draft.name !== undefined) edits.display_name = draft.name;
      if (draft.about !== undefined) edits.about = draft.about;
      if (draft.website !== undefined) edits.website = draft.website;
      if (draft.nip05 !== undefined) edits.nip05 = draft.nip05;
      for (const [field, image] of [
        ["picture", draft.photo],
        ["banner", draft.banner],
      ] as const) {
        if (image?.kind === "remove") edits[field] = "";
        if (image?.kind === "upload" && image.url) edits[field] = image.url;
      }
      if (!valid()) return "cancelled";
      try {
        await publishEdits(edits, signal);
      } catch {
        return valid() ? "relays" : "cancelled";
      }
      if (!valid()) return "cancelled";
      for (const field of ["photo", "banner"] as const) {
        const item = draft[field];
        try {
          if (item?.kind === "remove") keepUploaded(field, null);
          else if (item?.kind === "upload" && item.url)
            keepUploaded(field, item.file, item.url);
        } catch {}
      }
      error = false;
      write(null);
      if (draft.photo.kind === "upload") remove(draft.photo.file);
      if (draft.banner?.kind === "upload") remove(draft.banner.file);
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
    publish,
    retry,
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      if (!active) {
        clearTimeout(timer);
        timer = undefined;
        abort?.abort();
      } else retry();
    },
    draftFiles() {
      return [snapshot.draft?.photo, snapshot.draft?.banner].flatMap((image) =>
        image?.kind === "upload" ? [image.file] : [],
      );
    },
  };
}
