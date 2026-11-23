import { and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";
import { attachmentId, jobSchema, type SpeechJob } from "@/core/speech/types";
import { speechJobs } from "./schema";

export function speechStore<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  account: string,
) {
  const owned = eq(speechJobs.account, account);
  const row = (id: string) => and(owned, eq(speechJobs.id, id));
  return {
    load() {
      return db
        .select({ job: speechJobs.job })
        .from(speechJobs)
        .where(owned)
        .all()
        .map(({ job }) => jobSchema.parse(JSON.parse(job)));
    },
    save(job: SpeechJob, sealed: string | null = null) {
      const payload = JSON.stringify(job);
      db.insert(speechJobs)
        .values({
          id: job.id,
          account,
          attachment: attachmentId(job.source),
          job: payload,
          sealed,
        })
        .onConflictDoUpdate({
          target: speechJobs.id,
          set: { job: payload, sealed },
        })
        .run();
    },
    read(id: string) {
      return db
        .select({ sealed: speechJobs.sealed })
        .from(speechJobs)
        .where(row(id))
        .get()?.sealed;
    },
    remove(id: string) {
      db.delete(speechJobs).where(row(id)).run();
    },
    clear() {
      db.delete(speechJobs).where(owned).run();
    },
    bytes() {
      return (
        db
          .select({
            bytes: sql<number>`COALESCE(SUM(length(${speechJobs.sealed})), 0)`,
          })
          .from(speechJobs)
          .where(owned)
          .get()?.bytes ?? 0
      );
    },
  };
}
