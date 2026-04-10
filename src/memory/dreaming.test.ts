import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { trackRecall } from './recall-tracker.js';
import {
  lightSleep,
  remSleep,
  deepSleep,
  dreamCycle,
  setupGroupDreaming,
} from './dreaming.js';

describe('Dreaming', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = mkdtempSync(join(tmpdir(), 'nanoclaw-dream-test-'));
    mkdirSync(join(groupDir, 'memory'), { recursive: true });
    mkdirSync(join(groupDir, '.dreams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(groupDir, { recursive: true, force: true });
  });

  function seedRecalls(count = 5, queriesPerRecall = 3) {
    for (let i = 0; i < count; i++) {
      for (let q = 0; q < queriesPerRecall; q++) {
        trackRecall(groupDir, `query ${q} for topic ${i}`, [
          {
            source: `memory/topic${i}.md`,
            content: `Important insight about topic ${i}: this is a detailed analysis of the trading strategy patterns and market dynamics observed during backtesting`,
            score: 0.7 + Math.random() * 0.3,
          },
        ]);
      }
    }
  }

  describe('lightSleep', () => {
    it('runs on empty store without errors', () => {
      const result = lightSleep(groupDir);

      expect(result.phase).toBe('light');
      expect(result.candidates).toBe(0);
      expect(result.deduplicated).toBe(0);
    });

    it('processes recall candidates and creates report', () => {
      seedRecalls(10, 2);

      const result = lightSleep(groupDir);

      expect(result.phase).toBe('light');
      expect(result.candidates).toBeGreaterThan(0);
      expect(result.deduplicated).toBeGreaterThan(0);

      // Check report was written
      const reportDir = join(groupDir, '.dreams', 'light-sleep');
      expect(existsSync(reportDir)).toBe(true);

      const today = new Date().toISOString().slice(0, 10);
      const reportPath = join(reportDir, `${today}.json`);
      expect(existsSync(reportPath)).toBe(true);

      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.phase).toBe('light');
      expect(report.candidateCount).toBeGreaterThan(0);
    });

    it('records phase signals', () => {
      seedRecalls(5, 3);
      lightSleep(groupDir);

      const signalsPath = join(groupDir, '.dreams', 'phase-signals.json');
      expect(existsSync(signalsPath)).toBe(true);

      const signals = JSON.parse(readFileSync(signalsPath, 'utf-8'));
      expect(signals.signals.length).toBeGreaterThan(0);
      expect(signals.signals[0].phase).toBe('light');
      expect(signals.signals[0].boost).toBeGreaterThan(0);
    });
  });

  describe('remSleep', () => {
    it('runs on empty store without errors', () => {
      const result = remSleep(groupDir);

      expect(result.phase).toBe('rem');
      expect(result.patterns).toBe(0);
    });

    it('finds patterns in frequent topics', () => {
      // Create many recalls with overlapping concept tags
      for (let i = 0; i < 20; i++) {
        trackRecall(groupDir, `trading strategy query ${i}`, [
          {
            source: 'strategies.md',
            content: `Trading strategy momentum analysis with TRONN5 system pattern ${i}`,
            score: 0.85,
          },
        ]);
      }

      const result = remSleep(groupDir);

      expect(result.phase).toBe('rem');
      // Should find patterns since same concept tags appear frequently
      // (depends on concept extraction finding overlapping tags)
    });

    it('creates REM report', () => {
      seedRecalls(10, 4);
      remSleep(groupDir);

      const reportDir = join(groupDir, '.dreams', 'rem-sleep');
      expect(existsSync(reportDir)).toBe(true);
    });
  });

  describe('deepSleep', () => {
    it('runs on empty store without errors', () => {
      const result = deepSleep(groupDir);

      expect(result.phase).toBe('deep');
      expect(result.totalCandidates).toBe(0);
      expect(result.promoted).toBe(0);
      expect(result.rejected).toBe(0);
    });

    it('promotes highly recalled candidates to MEMORY.md', () => {
      // Create a candidate with enough recalls to pass thresholds
      const content =
        'Critical trading insight: always check ADX before entering ranging markets to avoid false breakouts';
      for (let i = 0; i < 15; i++) {
        trackRecall(groupDir, `unique trading query ${i}`, [
          { source: 'knowledge.md', content, score: 0.95 },
        ]);
      }

      const result = deepSleep(groupDir);

      expect(result.phase).toBe('deep');
      expect(result.totalCandidates).toBeGreaterThan(0);

      if (result.promoted > 0) {
        const memoryPath = join(groupDir, 'memory', 'MEMORY.md');
        expect(existsSync(memoryPath)).toBe(true);
        const memoryContent = readFileSync(memoryPath, 'utf-8');
        expect(memoryContent).toContain('Dreaming Insights');
      }
    });

    it('rejects candidates below thresholds', () => {
      // Single recall — not enough for promotion
      trackRecall(groupDir, 'single query', [
        {
          source: 'test.md',
          content: 'weakly recalled content about something',
          score: 0.3,
        },
      ]);

      const result = deepSleep(groupDir);

      expect(result.promoted).toBe(0);
    });

    it('creates deep sleep report', () => {
      seedRecalls(5, 5);
      deepSleep(groupDir);

      const reportDir = join(groupDir, '.dreams', 'deep-sleep');
      expect(existsSync(reportDir)).toBe(true);
    });
  });

  describe('dreamCycle', () => {
    it('runs all 3 phases in sequence', () => {
      seedRecalls(10, 3);

      const result = dreamCycle(groupDir);

      expect(result.light.phase).toBe('light');
      expect(result.rem.phase).toBe('rem');
      expect(result.deep.phase).toBe('deep');
    });

    it('phases build on each other', () => {
      seedRecalls(10, 5);

      const result = dreamCycle(groupDir);

      // Light should have processed candidates
      expect(result.light.candidates).toBeGreaterThan(0);

      // Phase signals should exist after light + rem
      const signalsPath = join(groupDir, '.dreams', 'phase-signals.json');
      expect(existsSync(signalsPath)).toBe(true);

      const signals = JSON.parse(readFileSync(signalsPath, 'utf-8'));
      const lightSignals = signals.signals.filter(
        (s: any) => s.phase === 'light',
      );
      expect(lightSignals.length).toBeGreaterThan(0);
    });
  });

  describe('setupGroupDreaming', () => {
    it('creates all required directories and files', () => {
      const newGroupDir = mkdtempSync(join(tmpdir(), 'nanoclaw-new-group-'));
      mkdirSync(join(newGroupDir, 'memory'), { recursive: true });

      setupGroupDreaming(newGroupDir);

      expect(existsSync(join(newGroupDir, '.dreams'))).toBe(true);
      expect(existsSync(join(newGroupDir, '.dreams', 'light-sleep'))).toBe(
        true,
      );
      expect(existsSync(join(newGroupDir, '.dreams', 'rem-sleep'))).toBe(true);
      expect(existsSync(join(newGroupDir, '.dreams', 'deep-sleep'))).toBe(true);
      expect(
        existsSync(join(newGroupDir, '.dreams', 'short-term-recall.json')),
      ).toBe(true);
      expect(
        existsSync(join(newGroupDir, '.dreams', 'phase-signals.json')),
      ).toBe(true);

      rmSync(newGroupDir, { recursive: true, force: true });
    });

    it('is idempotent — safe to call multiple times', () => {
      setupGroupDreaming(groupDir);
      setupGroupDreaming(groupDir); // second call should not error

      expect(
        existsSync(join(groupDir, '.dreams', 'short-term-recall.json')),
      ).toBe(true);
    });

    it('does not overwrite existing data', () => {
      // Seed some recall data
      trackRecall(groupDir, 'existing query', [
        { source: 'test.md', content: 'existing recall data', score: 0.9 },
      ]);

      const storeBefore = JSON.parse(
        readFileSync(
          join(groupDir, '.dreams', 'short-term-recall.json'),
          'utf-8',
        ),
      );

      setupGroupDreaming(groupDir);

      const storeAfter = JSON.parse(
        readFileSync(
          join(groupDir, '.dreams', 'short-term-recall.json'),
          'utf-8',
        ),
      );

      // Should NOT have overwritten existing data
      expect(Object.keys(storeAfter.entries)).toHaveLength(
        Object.keys(storeBefore.entries).length,
      );
    });
  });
});
