import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

export function initializeTestDatabase(sqlite: Database) {
  sqlite.exec("PRAGMA foreign_keys = ON");
  migrate(drizzle(sqlite), {
    migrationsFolder: join(import.meta.dir, "../src/db/migrations"),
  });
}
