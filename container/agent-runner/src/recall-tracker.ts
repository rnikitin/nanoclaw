/**
 * Recall tracker — container-side.
 *
 * Shared by the active-recall prompt injection (index.ts) and the
 * memory_search MCP tool (memory-mcp-stdio.ts). Persists to
 * .dreams/recall.db (sqlite) with the same schema as the host
 * src/memory/recall-tracker.ts, so the dreaming engine on the host can
 * consume them interchangeably.
 *
 * conceptTags is intentionally left empty here; the host extracts tags
 * from full content during dreaming, not on every container recall.
 */

import BetterSqlite3, { type Database } from 'better-sqlite3';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';

import { todayISO } from './date-utils.js';

export interface RecallEntry {
  contentHash: string;
  source: string;
  recallCount: number;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  avgScore: number;
  firstSeen: string;
  lastRecalled: string;
  snippet: string;
}

const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const MAX_SNIPPET_CHARS = 280;
const MIN_TRACK_SCORE = 0.5;

function hashStr(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

const dbCache = new Map<string, Database>();

function openRecallDb(groupDir: string): Database {
  const dreamsDir = join(groupDir, '.dreams');
  const dbPath = join(dreamsDir, 'recall.db');
  const cached = dbCache.get(dbPath);
  if (cached && cached.open) return cached;

  mkdirSync(dreamsDir, { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');
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
  dbCache.set(dbPath, db);
  return db;
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

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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

export function trackContainerRecall(
  groupDir: string,
  query: string,
  results: Array<{ source: string; content: string; score: number }>,
): void {
  const tracked = results.filter((r) => r.score >= MIN_TRACK_SCORE);
  if (tracked.length === 0) return;

  try {
    const db = openRecallDb(groupDir);
    const queryHash = hashStr(query);
    const day = todayISO();
    const now = new Date().toISOString();

    const getStmt = db.prepare<[string]>(
      'SELECT * FROM recall_entries WHERE content_hash = ?',
    );
    const upsert = db.prepare(`
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

    db.transaction(() => {
      for (const r of tracked) {
        const ch = hashStr(r.content);
        const existing = getStmt.get(ch) as RawRow | undefined;
        let entry: RecallEntry;
        if (existing) {
          entry = rowToEntry(existing);
        } else {
          entry = {
            contentHash: ch,
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

        upsert.run({
          content_hash: entry.contentHash,
          source: entry.source,
          recall_count: entry.recallCount,
          query_hashes: JSON.stringify(entry.queryHashes),
          recall_days: JSON.stringify(entry.recallDays),
          concept_tags: JSON.stringify(entry.conceptTags),
          avg_score: entry.avgScore,
          first_seen: entry.firstSeen,
          last_recalled: entry.lastRecalled,
          snippet: entry.snippet,
        });
      }
    })();
  } catch {
    /* Silently fail — tracking failure doesn't block the search caller */
  }
}
