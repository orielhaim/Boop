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
    const db = drizzle(sqlite, { schema });
    await migrate(db, migrations);
    return db;
  } catch (error) {
    sqlite.closeSync();
    throw error;
  }
}
