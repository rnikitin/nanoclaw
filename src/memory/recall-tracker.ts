/**
 * Recall Tracker — records what memory chunks are retrieved by agents.
 *
 * Every memory_search call silently records:
 * - Which chunk was found
 * - From which query
 * - On which day
 * - Relevance score
 *
 * This data feeds the dreaming scoring system — frequently recalled
 * memories get promoted to long-term storage.
 *
 * Storage: groups/{name}/.dreams/short-term-recall.json
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { todayISO } from './date-utils.js';
import { ensureDreamsDir, writeDreamsJson } from './dreams-io.js';

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
const LOCK_TIMEOUT_MS = 60_000;

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

  // Count frequency
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
  return join(groupDir, '.dreams', 'short-term-recall.json');
}

export function loadRecallStore(groupDir: string): RecallStore {
  const path = getRecallStorePath(groupDir);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    // corrupted file, start fresh
  }
  return { version: 1, entries: {}, lastUpdated: new Date().toISOString() };
}

export function saveRecallStore(groupDir: string, store: RecallStore): void {
  ensureDreamsDir(groupDir);
  store.lastUpdated = new Date().toISOString();
  writeDreamsJson(getRecallStorePath(groupDir), store);
}

/**
 * Record a recall event — called after each memory_search result.
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
  const store = loadRecallStore(groupDir);
  const queryHash = hashString(query);
  const day = todayISO();

  for (const result of results) {
    const contentHash = hashString(result.content);

    if (!store.entries[contentHash]) {
      store.entries[contentHash] = {
        contentHash,
        source: result.source,
        recallCount: 0,
        queryHashes: [],
        recallDays: [],
        conceptTags: [],
        avgScore: 0,
        firstSeen: new Date().toISOString(),
        lastRecalled: new Date().toISOString(),
        snippet: result.content.slice(0, MAX_SNIPPET_CHARS),
      };
    }

    const entry = store.entries[contentHash];
    entry.recallCount++;
    entry.lastRecalled = new Date().toISOString();

    // Update average score
    entry.avgScore =
      (entry.avgScore * (entry.recallCount - 1) + result.score) /
      entry.recallCount;

    // Add query hash (dedup, max 32)
    if (!entry.queryHashes.includes(queryHash)) {
      entry.queryHashes.push(queryHash);
      if (entry.queryHashes.length > MAX_QUERY_HASHES) {
        entry.queryHashes.shift();
      }
    }

    // Add recall day (dedup, max 16)
    if (!entry.recallDays.includes(day)) {
      entry.recallDays.push(day);
      if (entry.recallDays.length > MAX_RECALL_DAYS) {
        entry.recallDays.shift();
      }
    }

    // Update concept tags
    entry.conceptTags = extractConcepts(result.content);
  }

  saveRecallStore(groupDir, store);
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
  const store = loadRecallStore(groupDir);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  return Object.values(store.entries)
    .filter((e) => now - new Date(e.firstSeen).getTime() < maxAgeMs)
    .sort((a, b) => {
      // Simple composite score for candidate ranking
      const scoreA = a.recallCount * a.avgScore * a.queryHashes.length;
      const scoreB = b.recallCount * b.avgScore * b.queryHashes.length;
      return scoreB - scoreA;
    })
    .slice(0, limit);
}
