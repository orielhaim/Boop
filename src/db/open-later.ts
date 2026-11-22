import { eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./index";
import { preference, setPreference } from "./queries";
import { settings } from "./schema";

const prefix = "marmot.opened.";
const stored = z.object({ body: z.string(), expiresAt: z.number().nullable() });

export function readOpenedMessage(
  db: Database,
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

export function saveOpenedMessage(
  db: Database,
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

export function removeOpenedMessage(db: Database, id: string) {
  db.delete(settings)
    .where(eq(settings.key, prefix + id))
    .run();
}

export function purgeExpiredOpenedMessages(db: Database) {
  db.delete(settings)
    .where(
      sql`${like(settings.key, prefix + "%")} AND
      CASE WHEN json_valid(${settings.value})
        THEN json_extract(${settings.value}, '$.expiresAt') <= ${Math.floor(Date.now() / 1_000)}
        ELSE 1 END`,
    )
    .run();
}
