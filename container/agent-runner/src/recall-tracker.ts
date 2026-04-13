/**
 * Recall tracker — container-side.
 *
 * Shared by the active-recall prompt injection (index.ts) and the
 * memory_search MCP tool (memory-mcp-stdio.ts). Both paths write into
 * .dreams/short-term-recall.json with the same format as the host
 * src/memory/recall-tracker.ts so the dreaming engine on the host can
 * consume them interchangeably.
 *
 * conceptTags is intentionally left empty here; the host extracts tags
 * from full content during dreaming, not on every container recall.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

interface RecallStore {
  version: number;
  entries: Record<string, RecallEntry>;
  lastUpdated: string;
}

const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const MAX_SNIPPET_CHARS = 280;

function hashStr(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function loadStore(storePath: string): RecallStore {
  try {
    if (existsSync(storePath)) {
      return JSON.parse(readFileSync(storePath, 'utf-8'));
    }
  } catch {
    /* corrupted file — start fresh */
  }
  return { version: 1, entries: {}, lastUpdated: new Date().toISOString() };
}

export function trackContainerRecall(
  groupDir: string,
  query: string,
  results: Array<{ source: string; content: string; score: number }>,
): void {
  if (results.length === 0) return;
  const dreamsDir = join(groupDir, '.dreams');
  const storePath = join(dreamsDir, 'short-term-recall.json');

  try {
    if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true });

    const store = loadStore(storePath);
    const queryHash = hashStr(query);
    const day = todayISO();
    const now = new Date().toISOString();

    for (const r of results) {
      const ch = hashStr(r.content);
      if (!store.entries[ch]) {
        store.entries[ch] = {
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
      const e = store.entries[ch];
      e.recallCount++;
      e.lastRecalled = now;
      e.avgScore =
        (e.avgScore * (e.recallCount - 1) + r.score) / e.recallCount;
      if (!e.queryHashes.includes(queryHash)) {
        e.queryHashes.push(queryHash);
        if (e.queryHashes.length > MAX_QUERY_HASHES) e.queryHashes.shift();
      }
      if (!e.recallDays.includes(day)) {
        e.recallDays.push(day);
        if (e.recallDays.length > MAX_RECALL_DAYS) e.recallDays.shift();
      }
    }

    store.lastUpdated = now;
    writeFileSync(storePath, JSON.stringify(store, null, 2));
  } catch {
    /* Silently fail — tracking failure doesn't block the search caller */
  }
}
