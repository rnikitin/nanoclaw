/**
 * Recall Tracker — records what memory chunks are retrieved by agents.
 *
 * Every memory_search call (with score ≥ 0.5) silently records:
 * - Which chunk was found
 * - From which query
 * - On which day
 * - Relevance score
 *
 * This data feeds the dreaming scoring system — frequently recalled
 * memories get promoted to long-term storage.
 *
 * Storage: groups/{name}/.dreams/recall.db (sqlite)
 * Legacy: .dreams/short-term-recall.json is auto-imported on first open
 * and then removed.
 */

import type { Database } from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';

import { openDb } from '../db-open.js';
import { todayISO } from './date-utils.js';
import { ensureDreamsDir } from './dreams-io.js';

export interface RecallEntry {
  /** Content hash (SHA-1 of chunk text) */
  contentHash: string;
  /** Source file path relative to group */
  source: string;
  /** Number of times recalled */
  recallCount: number;
  /** Unique query hashes (max 32) */
  queryHashes: string[];
  /** Days on which this was recalled (max 16) */
  recallDays: string[];
  /** Concept tags extracted from content */
  conceptTags: string[];
  /** Average relevance score */
  avgScore: number;
  /** First seen timestamp */
  firstSeen: string;
  /** Last recalled timestamp */
  lastRecalled: string;
  /** Snippet of the content (max 280 chars) */
  snippet: string;
}

export interface RecallStore {
  version: number;
  entries: Record<string, RecallEntry>;
  lastUpdated: string;
}

const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const MAX_SNIPPET_CHARS = 280;
const MAX_ENTRY_AGE_DAYS = 30;
const MIN_TRACK_SCORE = 0.5;

function hashString(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function extractConcepts(text: string, maxTags = 8): string[] {
  const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'need',
    'dare',
    'ought',
    'used',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'out',
    'off',
    'over',
    'under',
    'again',
    'further',
    'then',
    'once',
    'и',
    'в',
    'на',
    'с',
    'по',
    'для',
    'что',
    'это',
    'как',
    'не',
    'но',
    'да',
    'он',
    'она',
    'они',
    'мы',
    'вы',
    'я',
    'ты',
    'его',
    'её',
    'их',
    'был',
    'была',
    'были',
    'будет',
    'если',
    'или',
    'то',
    'так',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s_-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([word]) => word);
}

export function getRecallStorePath(groupDir: string): string {
  return join(groupDir, '.dreams', 'recall.db');
}

function getLegacyJsonPath(groupDir: string): string {
  return join(groupDir, '.dreams', 'short-term-recall.json');
}

const dbCache = new Map<string, Database>();

function openRecallDb(groupDir: string): Database {
  const dbPath = getRecallStorePath(groupDir);
  const cached = dbCache.get(dbPath);
  if (cached && cached.open) return cached;

  ensureDreamsDir(groupDir);
  const db = openDb(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_entries (
      content_hash  TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      recall_count  INTEGER NOT NULL,
      query_hashes  TEXT NOT NULL,
      recall_days   TEXT NOT NULL,
      concept_tags  TEXT NOT NULL,
      avg_score     REAL NOT NULL,
      first_seen    TEXT NOT NULL,
      last_recalled TEXT NOT NULL,
      snippet       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_last_recalled
      ON recall_entries(last_recalled);
    CREATE INDEX IF NOT EXISTS idx_recall_first_seen
      ON recall_entries(first_seen);
  `);
  migrateLegacyJsonIfPresent(groupDir, db);
  dbCache.set(dbPath, db);
  return db;
}

function migrateLegacyJsonIfPresent(groupDir: string, db: Database): void {
  const legacyPath = getLegacyJsonPath(groupDir);
  if (!existsSync(legacyPath)) return;

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM recall_entries')
    .get() as { n: number };
  if (existing.n > 0) {
    renameSync(legacyPath, legacyPath + '.migrated');
    return;
  }

  let parsed: RecallStore | null = null;
  try {
    parsed = JSON.parse(readFileSync(legacyPath, 'utf-8')) as RecallStore;
  } catch {
    renameSync(legacyPath, legacyPath + '.migrated');
    return;
  }

  const upsert = prepareUpsert(db);
  const txn = db.transaction((entries: Record<string, RecallEntry>) => {
    for (const e of Object.values(entries)) upsert(e);
  });
  if (parsed?.entries) txn(parsed.entries);
  renameSync(legacyPath, legacyPath + '.migrated');
}

function prepareUpsert(db: Database): (e: RecallEntry) => void {
  const stmt = db.prepare(`
    INSERT INTO recall_entries (
      content_hash, source, recall_count, query_hashes, recall_days,
      concept_tags, avg_score, first_seen, last_recalled, snippet
    ) VALUES (
      @content_hash, @source, @recall_count, @query_hashes, @recall_days,
      @concept_tags, @avg_score, @first_seen, @last_recalled, @snippet
    )
    ON CONFLICT(content_hash) DO UPDATE SET
      source        = excluded.source,
      recall_count  = excluded.recall_count,
      query_hashes  = excluded.query_hashes,
      recall_days   = excluded.recall_days,
      concept_tags  = excluded.concept_tags,
      avg_score     = excluded.avg_score,
      last_recalled = excluded.last_recalled,
      snippet       = excluded.snippet
  `);
  return (e: RecallEntry) =>
    stmt.run({
      content_hash: e.contentHash,
      source: e.source,
      recall_count: e.recallCount,
      query_hashes: JSON.stringify(e.queryHashes),
      recall_days: JSON.stringify(e.recallDays),
      concept_tags: JSON.stringify(e.conceptTags),
      avg_score: e.avgScore,
      first_seen: e.firstSeen,
      last_recalled: e.lastRecalled,
      snippet: e.snippet,
    });
}

interface RawRow {
  content_hash: string;
  source: string;
  recall_count: number;
  query_hashes: string;
  recall_days: string;
  concept_tags: string;
  avg_score: number;
  first_seen: string;
  last_recalled: string;
  snippet: string;
}

function rowToEntry(r: RawRow): RecallEntry {
  return {
    contentHash: r.content_hash,
    source: r.source,
    recallCount: r.recall_count,
    queryHashes: safeParseArray(r.query_hashes),
    recallDays: safeParseArray(r.recall_days),
    conceptTags: safeParseArray(r.concept_tags),
    avgScore: r.avg_score,
    firstSeen: r.first_seen,
    lastRecalled: r.last_recalled,
    snippet: r.snippet,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function loadRecallStore(groupDir: string): RecallStore {
  const emptyStore: RecallStore = {
    version: 1,
    entries: {},
    lastUpdated: new Date().toISOString(),
  };
  try {
    const db = openRecallDb(groupDir);
    const rows = db.prepare('SELECT * FROM recall_entries').all() as RawRow[];
    const entries: Record<string, RecallEntry> = {};
    for (const r of rows) entries[r.content_hash] = rowToEntry(r);
    return { version: 1, entries, lastUpdated: new Date().toISOString() };
  } catch {
    return emptyStore;
  }
}

function pruneOldEntries(db: Database): void {
  const cutoff = new Date(
    Date.now() - MAX_ENTRY_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  db.prepare('DELETE FROM recall_entries WHERE last_recalled < ?').run(cutoff);
}

/**
 * Replace the entire store contents with the provided entries. Used by
 * dreaming phases that rewrite the full recall map after scoring updates.
 */
export function saveRecallStore(groupDir: string, store: RecallStore): void {
  const db = openRecallDb(groupDir);
  const upsert = prepareUpsert(db);
  db.transaction(() => {
    db.exec('DELETE FROM recall_entries');
    for (const e of Object.values(store.entries)) upsert(e);
    pruneOldEntries(db);
  })();
}

/**
 * Record a recall event — called after each memory_search result.
 * Results with score < 0.5 are skipped (below injection threshold).
 */
export function trackRecall(
  groupDir: string,
  query: string,
  results: Array<{
    source: string;
    content: string;
    score: number;
  }>,
): void {
  const tracked = results.filter((r) => r.score >= MIN_TRACK_SCORE);
  if (tracked.length === 0) return;

  const db = openRecallDb(groupDir);
  const queryHash = hashString(query);
  const day = todayISO();
  const now = new Date().toISOString();

  const getStmt = db.prepare<[string]>(
    'SELECT * FROM recall_entries WHERE content_hash = ?',
  );
  const upsert = prepareUpsert(db);

  db.transaction(() => {
    for (const r of tracked) {
      const contentHash = hashString(r.content);
      const existing = getStmt.get(contentHash) as RawRow | undefined;
      let entry: RecallEntry;
      if (existing) {
        entry = rowToEntry(existing);
      } else {
        entry = {
          contentHash,
          source: r.source,
          recallCount: 0,
          queryHashes: [],
          recallDays: [],
          conceptTags: [],
          avgScore: 0,
          firstSeen: now,
          lastRecalled: now,
          snippet: r.content.slice(0, MAX_SNIPPET_CHARS),
        };
      }

      entry.recallCount++;
      entry.lastRecalled = now;
      entry.avgScore =
        (entry.avgScore * (entry.recallCount - 1) + r.score) /
        entry.recallCount;

      if (!entry.queryHashes.includes(queryHash)) {
        entry.queryHashes.push(queryHash);
        if (entry.queryHashes.length > MAX_QUERY_HASHES) {
          entry.queryHashes.shift();
        }
      }
      if (!entry.recallDays.includes(day)) {
        entry.recallDays.push(day);
        if (entry.recallDays.length > MAX_RECALL_DAYS) {
          entry.recallDays.shift();
        }
      }
      entry.conceptTags = extractConcepts(r.content);

      upsert(entry);
    }
  })();
}

/**
 * Get recall entries sorted by a combined score.
 * Used by dreaming phases to find promotion candidates.
 */
export function getTopRecallCandidates(
  groupDir: string,
  limit = 20,
  maxAgeDays = 30,
): RecallEntry[] {
  try {
    const db = openRecallDb(groupDir);
    const cutoff = new Date(
      Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = db
      .prepare('SELECT * FROM recall_entries WHERE first_seen > ?')
      .all(cutoff) as RawRow[];
    return rows
      .map(rowToEntry)
      .sort((a, b) => {
        const scoreA = a.recallCount * a.avgScore * a.queryHashes.length;
        const scoreB = b.recallCount * b.avgScore * b.queryHashes.length;
        return scoreB - scoreA;
      })
      .slice(0, limit);
  } catch {
    return [];
  }
}
