import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { eq, like, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { parseTimeLock } from "@/core/messaging/special-messages/timelock";
import { preference, setPreference } from "./queries";
import type * as schema from "./schema";
import { settings } from "./schema";

type OpenLaterDb<TResult> = BaseSQLiteDatabase<"sync", TResult, typeof schema>;
const prefix = "marmot.opened.";
const submissionPrefix = "marmot.openLaterSubmission.";
const stored = z.object({ body: z.string(), expiresAt: z.number().nullable() });
const submissionSchema = z.object({
  draftKey: z.string(),
  body: z.string().max(18_000),
  token: z.uuid(),
  time: z.number().int(),
});
type OpenLaterSubmission = z.infer<typeof submissionSchema>;

export function openLaterDraftKey(text: string, reply: string | null) {
  return bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify([text, reply]))),
  );
}

export function readOpenLaterSubmission<TResult>(
  db: OpenLaterDb<TResult>,
  group: string,
  draftKey: string,
) {
  const value = preference(db, submissionPrefix + group);
  if (!value) return null;
  try {
    const saved = submissionSchema.parse(JSON.parse(value));
    return saved.draftKey === draftKey &&
      parseTimeLock(JSON.parse(saved.body))?.requestedAt === saved.time
      ? saved
      : null;
  } catch {
    return null;
  }
}

export function saveOpenLaterSubmission<TResult>(
  db: OpenLaterDb<TResult>,
  group: string,
  submission: OpenLaterSubmission,
) {
  setPreference(db, submissionPrefix + group, JSON.stringify(submission));
}

export function removeOpenLaterSubmission<TResult>(
  db: OpenLaterDb<TResult>,
  group: string,
  token: string,
) {
  db.delete(settings)
    .where(
      sql`${eq(settings.key, submissionPrefix + group)} AND
        json_extract(${settings.value}, '$.token') = ${token}`,
    )
    .run();
}

export function readOpenedMessage<TResult>(
  db: OpenLaterDb<TResult>,
  id: string,
  expiresAt?: number | null,
) {
  const saved = preference(db, prefix + id);
  if (!saved || (expiresAt && expiresAt * 1_000 <= Date.now())) return null;
  try {
    const value = stored.parse(JSON.parse(saved));
    return value.expiresAt === null || value.expiresAt * 1_000 > Date.now()
      ? value.body
      : null;
  } catch {
    return null;
  }
}

export function saveOpenedMessage<TResult>(
  db: OpenLaterDb<TResult>,
  id: string,
  body: string,
  expiresAt?: number | null,
) {
  if (expiresAt && expiresAt * 1_000 <= Date.now()) return;
  setPreference(
    db,
    prefix + id,
    JSON.stringify({ body, expiresAt: expiresAt ?? null }),
  );
}

export function removeOpenedMessage<TResult>(
  db: OpenLaterDb<TResult>,
  id: string,
) {
  db.delete(settings)
    .where(eq(settings.key, prefix + id))
    .run();
}

export function purgeExpiredOpenedMessages<TResult>(db: OpenLaterDb<TResult>) {
  db.delete(settings)
    .where(
      sql`${like(settings.key, prefix + "%")} AND
      CASE WHEN json_valid(${settings.value})
        THEN json_extract(${settings.value}, '$.expiresAt') <= ${Math.floor(Date.now() / 1_000)}
        ELSE 1 END`,
    )
    .run();
}
