import { drizzle } from "drizzle-orm/expo-sqlite";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import { openDatabaseSync } from "expo-sqlite";
import migrations from "./migrations/bundle";
import * as schema from "./schema";

export type Database = Awaited<ReturnType<typeof openDatabase>>;

export async function openDatabase() {
  const sqlite = openDatabaseSync("boop.db", { enableChangeListener: true });
  try {
    sqlite.execSync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = sqlite.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if (
      version?.user_version !== 1 &&
      sqlite.getFirstSync(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1",
      )
    )
      throw new Error("Boop requires a fresh database. See DEVELOPMENT.md.");
    const db = drizzle(sqlite, { schema });
    await migrate(db, migrations);
    return db;
  } catch (error) {
    sqlite.closeSync();
    throw error;
  }
}
