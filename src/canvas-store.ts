/**
 * Canvas State Store — SQLite-backed storage for canvas sessions.
 *
 * Persists JSX code, state, and metadata across restarts.
 * TTL-based cleanup of inactive canvases (24h default).
 */
import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';
import { ensureDir } from './fs-utils.js';

export interface CanvasSession {
  canvasId: string;
  group: string;
  chatJid: string;
  title: string;
  jsx: string;
  state: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const CANVAS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let db: Database.Database;

// In-memory cache for fast reads
const cache = new Map<string, CanvasSession>();

export function initCanvasStore(): void {
  const dbPath = path.join(STORE_DIR, 'canvas.db');
  ensureDir(path.dirname(dbPath));

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS canvases (
      canvas_id TEXT PRIMARY KEY,
      "group" TEXT NOT NULL,
      chat_jid TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT 'Canvas',
      jsx TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Load all into cache
  const rows = db.prepare('SELECT * FROM canvases').all() as Array<{
    canvas_id: string;
    group: string;
    chat_jid: string;
    title: string;
    jsx: string;
    state: string;
    created_at: number;
    updated_at: number;
  }>;

  for (const row of rows) {
    cache.set(row.canvas_id, {
      canvasId: row.canvas_id,
      group: row.group,
      chatJid: row.chat_jid,
      title: row.title,
      jsx: row.jsx,
      state: JSON.parse(row.state),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

const upsertStmt = () =>
  db.prepare(`
  INSERT INTO canvases (canvas_id, "group", chat_jid, title, jsx, state, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(canvas_id) DO UPDATE SET
    "group" = excluded."group",
    chat_jid = excluded.chat_jid,
    title = excluded.title,
    jsx = excluded.jsx,
    state = excluded.state,
    updated_at = excluded.updated_at
`);

export function createCanvas(
  canvasId: string,
  group: string,
  chatJid: string,
  title: string,
  jsx: string,
  state: Record<string, unknown>,
): CanvasSession {
  const now = Date.now();
  const session: CanvasSession = {
    canvasId,
    group,
    chatJid,
    title,
    jsx,
    state,
    createdAt: now,
    updatedAt: now,
  };

  cache.set(canvasId, session);
  upsertStmt().run(
    canvasId,
    group,
    chatJid,
    title,
    jsx,
    JSON.stringify(state),
    now,
    now,
  );

  return session;
}

export function updateCanvas(
  canvasId: string,
  jsx?: string,
  state?: Record<string, unknown>,
): CanvasSession | null {
  const session = cache.get(canvasId);
  if (!session) return null;

  if (jsx !== undefined) session.jsx = jsx;
  if (state !== undefined) session.state = { ...session.state, ...state };
  session.updatedAt = Date.now();

  cache.set(canvasId, session);
  upsertStmt().run(
    session.canvasId,
    session.group,
    session.chatJid,
    session.title,
    session.jsx,
    JSON.stringify(session.state),
    session.createdAt,
    session.updatedAt,
  );

  return session;
}

export function getCanvas(canvasId: string): CanvasSession | null {
  return cache.get(canvasId) ?? null;
}

export function deleteCanvas(canvasId: string): boolean {
  cache.delete(canvasId);
  const result = db
    .prepare('DELETE FROM canvases WHERE canvas_id = ?')
    .run(canvasId);
  return result.changes > 0;
}

export function listCanvases(group?: string): CanvasSession[] {
  const all = Array.from(cache.values());
  return group ? all.filter((s) => s.group === group) : all;
}

/**
 * Remove canvases that haven't been updated within the TTL.
 */
export function cleanupExpiredCanvases(): string[] {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, session] of cache) {
    if (now - session.updatedAt > CANVAS_TTL_MS) {
      cache.delete(id);
      expired.push(id);
    }
  }
  if (expired.length > 0) {
    const placeholders = expired.map(() => '?').join(',');
    db.prepare(`DELETE FROM canvases WHERE canvas_id IN (${placeholders})`).run(
      ...expired,
    );
  }
  return expired;
}
