import { drizzle } from "drizzle-orm/expo-sqlite";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";
import { File } from "expo-file-system";
import {
  defaultDatabaseDirectory,
  deleteDatabaseAsync,
  openDatabaseSync,
} from "expo-sqlite";
import migrations from "./migrations/migrations.js";
import * as schema from "./schema";

export type Database = Awaited<ReturnType<typeof openDatabase>>;

export class IncompatibleDatabaseError extends Error {
  constructor() {
    super("Boop requires a fresh database. See DEVELOPMENT.md.");
  }
}

const databaseName = (account?: string) =>
  account ? `boop-account-${account}.db` : "boop-installation.db";

export async function removeAccountDatabase(account: string) {
  const name = databaseName(account);
  if (new File(defaultDatabaseDirectory, name).exists)
    await deleteDatabaseAsync(name);
}

export async function openDatabase(account?: string) {
  const sqlite = openDatabaseSync(databaseName(account), {
    enableChangeListener: true,
  });
  try {
    sqlite.execSync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const version = sqlite.getFirstSync<{ user_version: number }>(
      "PRAGMA user_version",
    );
    if (
      version?.user_version !== 4 &&
      sqlite.getFirstSync(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1",
      )
    )
      throw new IncompatibleDatabaseError();
    const db = drizzle(sqlite, { schema });
    await migrate(db, migrations);
    return db;
  } catch (error) {
    sqlite.closeSync();
    throw error;
  }
}
