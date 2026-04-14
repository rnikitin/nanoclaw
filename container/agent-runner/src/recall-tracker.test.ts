import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { trackContainerRecall } from './recall-tracker.js';

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

function openRecall(groupDir: string) {
  return new BetterSqlite3(join(groupDir, '.dreams', 'recall.db'));
}

describe('container trackContainerRecall', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = mkdtempSync(join(tmpdir(), 'nanoclaw-container-recall-'));
  });

  afterEach(() => {
    rmSync(groupDir, { recursive: true, force: true });
  });

  it('creates recall.db on first tracked result', () => {
    trackContainerRecall(groupDir, 'hello', [
      { source: 'a.md', content: 'first chunk of content', score: 0.9 },
    ]);
    expect(existsSync(join(groupDir, '.dreams', 'recall.db'))).toBe(true);
  });

  it('skips writes with score below 0.5 threshold', () => {
    trackContainerRecall(groupDir, 'noisy', [
      { source: 'low.md', content: 'too low to keep', score: 0.3 },
    ]);
    // No DB ever opened — directory shouldn't exist
    expect(existsSync(join(groupDir, '.dreams', 'recall.db'))).toBe(false);
  });

  it('increments recallCount + avgScore across repeated calls', () => {
    const content = 'repeated chunk about strategy';
    trackContainerRecall(groupDir, 'q1', [
      { source: 'test.md', content, score: 0.8 },
    ]);
    trackContainerRecall(groupDir, 'q2', [
      { source: 'test.md', content, score: 1.0 },
    ]);

    const db = openRecall(groupDir);
    const row = db
      .prepare('SELECT * FROM recall_entries')
      .get() as RawRow;
    expect(row.recall_count).toBe(2);
    expect(row.avg_score).toBeCloseTo(0.9, 5);
    expect(JSON.parse(row.query_hashes)).toHaveLength(2);
    db.close();
  });

  it('deduplicates query hashes on same query', () => {
    trackContainerRecall(groupDir, 'same', [
      { source: 'a.md', content: 'chunk', score: 0.7 },
    ]);
    trackContainerRecall(groupDir, 'same', [
      { source: 'a.md', content: 'chunk', score: 0.8 },
    ]);

    const db = openRecall(groupDir);
    const row = db
      .prepare('SELECT * FROM recall_entries')
      .get() as RawRow;
    expect(row.recall_count).toBe(2);
    expect(JSON.parse(row.query_hashes)).toHaveLength(1);
    db.close();
  });

  it('writes schema that matches host reader shape', () => {
    trackContainerRecall(groupDir, 'q', [
      { source: 'a.md', content: 'chunk', score: 0.9 },
    ]);
    const db = openRecall(groupDir);
    const cols = db
      .prepare("PRAGMA table_info('recall_entries')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'avg_score',
        'concept_tags',
        'content_hash',
        'first_seen',
        'last_recalled',
        'query_hashes',
        'recall_count',
        'recall_days',
        'snippet',
        'source',
      ].sort(),
    );
    db.close();
  });

  it('caps snippet at 280 chars', () => {
    const longContent = 'z'.repeat(500);
    trackContainerRecall(groupDir, 'q', [
      { source: 'long.md', content: longContent, score: 0.9 },
    ]);
    const db = openRecall(groupDir);
    const row = db
      .prepare('SELECT snippet FROM recall_entries')
      .get() as { snippet: string };
    expect(row.snippet.length).toBeLessThanOrEqual(280);
    db.close();
  });
});
