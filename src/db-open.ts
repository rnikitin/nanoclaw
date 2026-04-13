import Database from 'better-sqlite3';

import { ensureDir } from './fs-utils.js';
import path from 'path';

export interface OpenDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** When false (default), set `journal_mode = WAL` on open. */
  wal?: boolean;
}

/**
 * Open a better-sqlite3 handle with the project's standard settings:
 * - parent dir is created for read-write paths,
 * - WAL pragma is applied for read-write handles by default,
 * - read-only handles skip WAL (avoids a writable-open side effect).
 */
export function openDb(
  dbPath: string,
  opts: OpenDbOptions = {},
): Database.Database {
  const { readonly = false, fileMustExist = false, wal } = opts;
  if (!readonly) {
    ensureDir(path.dirname(dbPath));
  }
  const db = new Database(dbPath, { readonly, fileMustExist });
  if (wal ?? !readonly) {
    db.pragma('journal_mode = WAL');
  }
  return db;
}
