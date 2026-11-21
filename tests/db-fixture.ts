import type { Database } from "bun:sqlite";
import baseline from "../src/db/migrations/bundle";

export function initializeTestDatabase(sqlite: Database) {
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.transaction(() => {
    for (const statement of baseline.migrations.m0000.split(
      "--> statement-breakpoint",
    ))
      sqlite.exec(statement);
  })();
}
