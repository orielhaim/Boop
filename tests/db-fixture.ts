import type { Database } from "bun:sqlite";
import baseline from "../src/db/migrations/bundle";

export function initializeTestDatabase(sqlite: Database) {
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.transaction(() => {
    for (const migration of Object.values(baseline.migrations))
      for (const statement of migration.split("--> statement-breakpoint"))
        sqlite.exec(statement);
  })();
}
