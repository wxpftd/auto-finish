import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Schema = typeof schema;
export type Db = BetterSQLite3Database<Schema>;
export type SqliteHandle = Database.Database;

export interface DbHandle {
  db: Db;
  sqlite: SqliteHandle;
}

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

function applyPragmas(sqlite: SqliteHandle, file: boolean): void {
  // WAL is only meaningful on a real file-backed DB; setting it on `:memory:`
  // is a no-op but better-sqlite3 still accepts it. We only call it for files
  // to keep test logs clean.
  if (file) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
}

/**
 * Create a Drizzle-wrapped better-sqlite3 connection at `filePath`.
 *
 * The caller is responsible for `runMigrations(db)` and for closing the
 * underlying handle when finished (`sqlite.close()`).
 */
export function createDb(filePath: string): DbHandle {
  const sqlite = new Database(filePath);
  applyPragmas(sqlite, true);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Create a Drizzle-wrapped in-memory better-sqlite3 connection.
 *
 * `:memory:` databases are per-connection in better-sqlite3, so each call
 * returns an isolated DB — handy for tests.
 */
export function createInMemoryDb(): DbHandle {
  const sqlite = new Database(':memory:');
  applyPragmas(sqlite, false);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Apply all generated migrations to the given Drizzle handle. The migration
 * folder is resolved relative to this source file so it works regardless of
 * the caller's cwd (notably under vitest).
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
