/**
 * Memory Seed — bootstrap recall tracking from existing memory and conversations.
 *
 * Reads all markdown files in memory/ and conversations/, splits into chunks,
 * and creates synthetic recall entries so the first dreaming cycle has data.
 *
 * After seeding, dreaming runs incrementally — only new memory_search calls
 * add new recall entries. The seed is a one-time bootstrap.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { loadRecallStore, saveRecallStore, type RecallEntry, type RecallStore } from './recall-tracker.js';

const MAX_CHUNK_CHARS = 500;
const MAX_SNIPPET_CHARS = 280;
const MIN_CHUNK_LENGTH = 50;

function hashStr(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function extractConcepts(text: string, maxTags = 8): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'и', 'в', 'на', 'с', 'по', 'для', 'что', 'это', 'как', 'не',
    'но', 'да', 'он', 'она', 'они', 'мы', 'вы', 'я', 'ты',
  ]);
  const words = text.toLowerCase()
    .replace(/[^a-zа-яё0-9\s_-]/gi, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([word]) => word);
}

/**
 * Split a markdown file into semantic chunks.
 * Splits on: ## headers, blank-line-separated paragraphs, and list blocks.
 * Each chunk is a self-contained unit of meaning.
 */
function chunkMarkdown(content: string): string[] {
  const chunks: string[] = [];

  // First pass: split on ## headers (sections)
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    if (section.trim().length < MIN_CHUNK_LENGTH) continue;

    // If section is small enough, keep as one chunk
    if (section.length <= MAX_CHUNK_CHARS) {
      chunks.push(section.trim());
      continue;
    }

    // Second pass: split large sections on blank lines (paragraphs)
    const paragraphs = section.split(/\n\s*\n/);
    let current = '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // If adding this paragraph would exceed limit, flush current
      if (current && (current.length + trimmed.length + 2) > MAX_CHUNK_CHARS) {
        if (current.length >= MIN_CHUNK_LENGTH) chunks.push(current);
        current = trimmed;
      } else {
        current = current ? current + '\n\n' + trimmed : trimmed;
      }
    }
    if (current.length >= MIN_CHUNK_LENGTH) chunks.push(current);
  }

  return chunks;
}

/** Truncate snippet at word boundary. */
function truncateSnippet(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(' ', maxLen);
  return cut > maxLen * 0.5 ? text.slice(0, cut) : text.slice(0, maxLen);
}

/** Recursively find all .md files in a directory */
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

export interface SeedResult {
  filesProcessed: number;
  chunksCreated: number;
  entriesAdded: number;
  skippedExisting: number;
}

/**
 * Seed recall store from existing files.
 *
 * @param groupDir - Group directory
 * @param dirs - Subdirectories to scan (default: ['memory', 'conversations'])
 * @param baseScore - Base relevance score for seeded entries (default: 0.6)
 */
export function seedRecallStore(
  groupDir: string,
  dirs: string[] = ['memory', 'conversations'],
  baseScore = 0.6,
): SeedResult {
  const store = loadRecallStore(groupDir);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  let filesProcessed = 0;
  let chunksCreated = 0;
  let entriesAdded = 0;
  let skippedExisting = 0;

  for (const subdir of dirs) {
    const scanDir = join(groupDir, subdir);
    const files = findMarkdownFiles(scanDir);

    for (const filePath of files) {
      filesProcessed++;
      const content = readFileSync(filePath, 'utf-8');
      const relPath = relative(groupDir, filePath);
      const chunks = chunkMarkdown(content);

      // Weight by file freshness — newer files get higher base score
      const stat = statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      const freshnessBoost = Math.exp(-0.693 * ageDays / 30); // 30-day half-life
      const fileScore = baseScore + 0.2 * freshnessBoost;

      for (const chunk of chunks) {
        chunksCreated++;
        const contentHash = hashStr(chunk);

        // Skip if already in store
        if (store.entries[contentHash]) {
          skippedExisting++;
          continue;
        }

        // Determine synthetic recall count from file importance
        let syntheticRecalls = 1;
        if (relPath.includes('context.md') || relPath.includes('index.md')) {
          syntheticRecalls = 3; // High-traffic files
        } else if (relPath.includes('knowledge/') || relPath.includes('projects/')) {
          syntheticRecalls = 2; // Important reference files
        }

        const entry: RecallEntry = {
          contentHash,
          source: relPath,
          recallCount: syntheticRecalls,
          queryHashes: [hashStr(`seed-${relPath}`)],
          recallDays: [today],
          conceptTags: extractConcepts(chunk),
          avgScore: Math.min(fileScore, 1),
          firstSeen: now,
          lastRecalled: now,
          snippet: truncateSnippet(chunk, MAX_SNIPPET_CHARS),
        };

        store.entries[contentHash] = entry;
        entriesAdded++;
      }
    }
  }

  saveRecallStore(groupDir, store);

  return { filesProcessed, chunksCreated, entriesAdded, skippedExisting };
}

/**
 * Seed recall store from SQLite message history.
 *
 * Groups messages into conversation windows (by day), creates chunks,
 * and adds them as recall entries with appropriate scoring.
 */
export function seedFromMessages(
  groupDir: string,
  dbPath: string,
  chatJid: string,
  baseScore = 0.55,
): SeedResult {
  let Database: any;
  try {
    Database = require('better-sqlite3');
  } catch {
    // Try native node:sqlite
    try {
      const { DatabaseSync } = require('node:sqlite');
      // Wrap in compatible interface
      const db = new DatabaseSync(dbPath, { readOnly: true });
      return _seedFromDb(groupDir, {
        prepare: (sql: string) => ({
          all: (...params: any[]) => {
            const stmt = db.prepare(sql);
            return stmt.all(...params);
          },
        }),
        close: () => db.close(),
      }, chatJid, baseScore);
    } catch {
      return { filesProcessed: 0, chunksCreated: 0, entriesAdded: 0, skippedExisting: 0 };
    }
  }

  const db = new Database(dbPath, { readonly: true });
  const result = _seedFromDb(groupDir, db, chatJid, baseScore);
  db.close();
  return result;
}

function _seedFromDb(
  groupDir: string,
  db: any,
  chatJid: string,
  baseScore: number,
): SeedResult {
  const store = loadRecallStore(groupDir);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  let filesProcessed = 0;
  let chunksCreated = 0;
  let entriesAdded = 0;
  let skippedExisting = 0;

  // Get messages grouped by day
  const rows = db.prepare(`
    SELECT content, sender_name, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND content IS NOT NULL AND content != ''
    ORDER BY timestamp ASC
  `).all(chatJid);

  if (!rows || rows.length === 0) {
    return { filesProcessed: 0, chunksCreated: 0, entriesAdded: 0, skippedExisting: 0 };
  }

  // Group messages into daily windows
  const dayGroups = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = (row.timestamp as string).slice(0, 10);
    if (!dayGroups.has(day)) dayGroups.set(day, []);
    dayGroups.get(day)!.push(row);
  }

  for (const [day, messages] of dayGroups) {
    filesProcessed++;

    // Build conversation text, chunk by character budget (semantic grouping)
    let currentChunk: string[] = [];
    let currentLen = 0;

    for (const msg of messages) {
      const prefix = msg.is_from_me ? 'Арк' : (msg.sender_name || 'User');
      const line = `${prefix}: ${msg.content}`;
      currentChunk.push(line);
      currentLen += line.length + 1;

      if (currentLen >= MAX_CHUNK_CHARS) {
        const text = currentChunk.join('\n').trim();
        if (text.length >= MIN_CHUNK_LENGTH) {
          chunksCreated++;
          const contentHash = hashStr(text);
          if (store.entries[contentHash]) {
            skippedExisting++;
          } else {
            // Newer messages get higher scores
            const msgDate = new Date(msg.timestamp as string);
            const ageMs = Date.now() - msgDate.getTime();
            const ageDays = ageMs / (24 * 60 * 60 * 1000);
            const freshnessBoost = Math.exp(-0.693 * ageDays / 30);
            const score = Math.min(baseScore + 0.25 * freshnessBoost, 1);

            store.entries[contentHash] = {
              contentHash,
              source: `messages/${day}`,
              recallCount: 1,
              queryHashes: [hashStr(`seed-msg-${day}-${chunksCreated}`)],
              recallDays: [day],
              conceptTags: extractConcepts(text),
              avgScore: score,
              firstSeen: msg.timestamp as string,
              lastRecalled: now,
              snippet: truncateSnippet(text, MAX_SNIPPET_CHARS),
            };
            entriesAdded++;
          }
        }
        currentChunk = [];
        currentLen = 0;
      }
    }

    // Remaining messages
    if (currentChunk.length > 0) {
      const text = currentChunk.join('\n').trim();
      if (text.length >= MIN_CHUNK_LENGTH) {
        chunksCreated++;
        const contentHash = hashStr(text);
        if (store.entries[contentHash]) {
          skippedExisting++;
        } else {
          store.entries[contentHash] = {
            contentHash,
            source: `messages/${day}`,
            recallCount: 1,
            queryHashes: [hashStr(`seed-msg-${day}-last`)],
            recallDays: [day],
            conceptTags: extractConcepts(text),
            avgScore: baseScore,
            firstSeen: now,
            lastRecalled: now,
            snippet: truncateSnippet(text, MAX_SNIPPET_CHARS),
          };
          entriesAdded++;
        }
      }
    }
  }

  saveRecallStore(groupDir, store);
  return { filesProcessed, chunksCreated, entriesAdded, skippedExisting };
}

/**
 * Seed all groups at once (files + messages).
 */
export function seedAllGroups(
  groupsDir: string,
  dbPath?: string,
): Record<string, SeedResult & { messages?: SeedResult }> {
  const results: Record<string, SeedResult & { messages?: SeedResult }> = {};

  // Load group registry for chat_jid mapping
  let groupJids: Record<string, string> = {};
  if (dbPath && existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare('SELECT folder, jid FROM registered_groups').all();
      for (const row of rows) {
        groupJids[row.folder as string] = row.jid as string;
      }
      db.close();
    } catch {
      // Try node:sqlite
      try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db.prepare('SELECT folder, jid FROM registered_groups').all();
        for (const row of rows as any[]) {
          groupJids[row.folder] = row.jid;
        }
        db.close();
      } catch { /* no DB access */ }
    }
  }

  for (const dir of readdirSync(groupsDir)) {
    const groupDir = join(groupsDir, dir);
    if (!existsSync(join(groupDir, 'memory'))) continue;

    // Seed from files
    const fileResult = seedRecallStore(groupDir);
    results[dir] = { ...fileResult };

    // Seed from messages if DB available
    if (dbPath && groupJids[dir]) {
      const msgResult = seedFromMessages(groupDir, dbPath, groupJids[dir]);
      results[dir].messages = msgResult;
    }
  }

  return results;
}
