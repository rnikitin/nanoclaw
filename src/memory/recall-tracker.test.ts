import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  trackRecall,
  loadRecallStore,
  getTopRecallCandidates,
  getRecallStorePath,
} from './recall-tracker.js';

describe('RecallTracker', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = mkdtempSync(join(tmpdir(), 'nanoclaw-test-'));
  });

  afterEach(() => {
    rmSync(groupDir, { recursive: true, force: true });
  });

  describe('trackRecall', () => {
    it('creates recall store on first call', () => {
      trackRecall(groupDir, 'test query', [
        {
          source: 'memory/context.md',
          content: 'some context about trading',
          score: 0.85,
        },
      ]);

      const storePath = getRecallStorePath(groupDir);
      expect(existsSync(storePath)).toBe(true);

      const store = loadRecallStore(groupDir);
      expect(store.version).toBe(1);
      expect(Object.keys(store.entries)).toHaveLength(1);
    });

    it('tracks recall count correctly', () => {
      const content = 'repeated memory chunk about strategy';

      trackRecall(groupDir, 'query 1', [
        { source: 'test.md', content, score: 0.8 },
      ]);
      trackRecall(groupDir, 'query 2', [
        { source: 'test.md', content, score: 0.9 },
      ]);
      trackRecall(groupDir, 'query 3', [
        { source: 'test.md', content, score: 0.7 },
      ]);

      const store = loadRecallStore(groupDir);
      const entry = Object.values(store.entries)[0];

      expect(entry.recallCount).toBe(3);
      expect(entry.queryHashes).toHaveLength(3);
      expect(entry.avgScore).toBeCloseTo(0.8, 1);
    });

    it('deduplicates query hashes', () => {
      const content = 'unique memory content here';

      // Same query twice
      trackRecall(groupDir, 'same query', [
        { source: 'test.md', content, score: 0.8 },
      ]);
      trackRecall(groupDir, 'same query', [
        { source: 'test.md', content, score: 0.9 },
      ]);

      const store = loadRecallStore(groupDir);
      const entry = Object.values(store.entries)[0];

      expect(entry.recallCount).toBe(2);
      expect(entry.queryHashes).toHaveLength(1); // same query = same hash
    });

    it('tracks multiple results from single query', () => {
      trackRecall(groupDir, 'multi result query', [
        { source: 'a.md', content: 'first result about alpha', score: 0.9 },
        { source: 'b.md', content: 'second result about beta', score: 0.7 },
        { source: 'c.md', content: 'third result about gamma', score: 0.5 },
      ]);

      const store = loadRecallStore(groupDir);
      expect(Object.keys(store.entries)).toHaveLength(3);
    });

    it('extracts concept tags from content', () => {
      trackRecall(groupDir, 'test', [
        {
          source: 'test.md',
          content:
            'TRONN5 strategy uses Claude Sonnet for trading decisions with momentum analysis',
          score: 0.9,
        },
      ]);

      const store = loadRecallStore(groupDir);
      const entry = Object.values(store.entries)[0];

      expect(entry.conceptTags.length).toBeGreaterThan(0);
      expect(
        entry.conceptTags.some(
          (t) =>
            t.includes('tronn5') ||
            t.includes('strategy') ||
            t.includes('trading'),
        ),
      ).toBe(true);
    });

    it('limits snippet length to 280 chars', () => {
      const longContent = 'x'.repeat(500);
      trackRecall(groupDir, 'test', [
        { source: 'test.md', content: longContent, score: 0.5 },
      ]);

      const store = loadRecallStore(groupDir);
      const entry = Object.values(store.entries)[0];

      expect(entry.snippet.length).toBeLessThanOrEqual(280);
    });

    it('limits query hashes to 32', () => {
      const content = 'same content for many queries';
      for (let i = 0; i < 40; i++) {
        trackRecall(groupDir, `unique query number ${i}`, [
          { source: 'test.md', content, score: 0.5 },
        ]);
      }

      const store = loadRecallStore(groupDir);
      const entry = Object.values(store.entries)[0];

      expect(entry.queryHashes.length).toBeLessThanOrEqual(32);
    });
  });

  describe('getTopRecallCandidates', () => {
    it('returns empty array for fresh store', () => {
      const candidates = getTopRecallCandidates(groupDir);
      expect(candidates).toHaveLength(0);
    });

    it('returns candidates sorted by composite score', () => {
      // High recall candidate
      for (let i = 0; i < 10; i++) {
        trackRecall(groupDir, `query ${i}`, [
          {
            source: 'hot.md',
            content: 'frequently recalled hot memory',
            score: 0.9,
          },
        ]);
      }
      // Low recall candidate (still above the 0.5 tracking threshold)
      trackRecall(groupDir, 'single query', [
        {
          source: 'cold.md',
          content: 'rarely recalled cold memory',
          score: 0.6,
        },
      ]);

      const candidates = getTopRecallCandidates(groupDir, 10);
      expect(candidates.length).toBe(2);
      expect(candidates[0].source).toBe('hot.md');
      expect(candidates[1].source).toBe('cold.md');
    });

    it('skips writes with score below 0.5 threshold', () => {
      trackRecall(groupDir, 'noisy', [
        { source: 'low.md', content: 'too low to keep', score: 0.3 },
      ]);
      expect(getTopRecallCandidates(groupDir, 10)).toHaveLength(0);
    });

    it('respects maxAgeDays filter', () => {
      trackRecall(groupDir, 'test', [
        { source: 'test.md', content: 'test content here', score: 0.5 },
      ]);

      // Should find it within 30 days
      expect(getTopRecallCandidates(groupDir, 10, 30)).toHaveLength(1);

      // Should find it within 0 days (just created)
      expect(getTopRecallCandidates(groupDir, 10, 0)).toHaveLength(0);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        trackRecall(groupDir, `query ${i}`, [
          {
            source: `file${i}.md`,
            content: `unique content number ${i} with words`,
            score: 0.5,
          },
        ]);
      }

      const candidates = getTopRecallCandidates(groupDir, 3);
      expect(candidates.length).toBeLessThanOrEqual(3);
    });
  });

  describe('loadRecallStore', () => {
    it('returns empty store for non-existent path', () => {
      const store = loadRecallStore('/nonexistent/path');
      expect(store.version).toBe(1);
      expect(Object.keys(store.entries)).toHaveLength(0);
    });

    it('handles corrupted legacy JSON gracefully during migration', () => {
      const dreamsDir = join(groupDir, '.dreams');
      require('fs').mkdirSync(dreamsDir, { recursive: true });
      require('fs').writeFileSync(
        join(dreamsDir, 'short-term-recall.json'),
        'not json',
      );

      const store = loadRecallStore(groupDir);
      expect(store.version).toBe(1);
      expect(Object.keys(store.entries)).toHaveLength(0);
    });

    it('migrates legacy JSON into sqlite on first open', () => {
      const dreamsDir = join(groupDir, '.dreams');
      require('fs').mkdirSync(dreamsDir, { recursive: true });
      const legacy = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        entries: {
          abc123def456: {
            contentHash: 'abc123def456',
            source: 'legacy.md',
            recallCount: 4,
            queryHashes: ['q1', 'q2'],
            recallDays: ['2026-04-10'],
            conceptTags: ['legacy'],
            avgScore: 0.8,
            firstSeen: new Date().toISOString(),
            lastRecalled: new Date().toISOString(),
            snippet: 'from json',
          },
        },
      };
      require('fs').writeFileSync(
        join(dreamsDir, 'short-term-recall.json'),
        JSON.stringify(legacy),
      );

      const store = loadRecallStore(groupDir);
      expect(Object.keys(store.entries)).toHaveLength(1);
      expect(store.entries['abc123def456'].source).toBe('legacy.md');
      expect(existsSync(join(dreamsDir, 'short-term-recall.json'))).toBe(false);
      expect(
        existsSync(join(dreamsDir, 'short-term-recall.json.migrated')),
      ).toBe(true);
    });
  });
});
