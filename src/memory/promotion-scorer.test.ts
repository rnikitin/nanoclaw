import { describe, it, expect } from 'vitest';
import {
  scoreCandidate,
  rankCandidates,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLDS,
} from './promotion-scorer.js';
import type { RecallEntry } from './recall-tracker.js';

function makeEntry(overrides: Partial<RecallEntry> = {}): RecallEntry {
  return {
    contentHash: 'abc123',
    source: 'test.md',
    recallCount: 5,
    queryHashes: ['q1', 'q2', 'q3', 'q4'],
    recallDays: ['2026-04-01', '2026-04-02', '2026-04-03'],
    conceptTags: ['trading', 'strategy', 'momentum', 'llm'],
    avgScore: 0.85,
    firstSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    lastRecalled: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
    snippet: 'TRONN5 strategy with momentum analysis for trading decisions',
    ...overrides,
  };
}

describe('PromotionScorer', () => {
  describe('scoreCandidate', () => {
    it('scores a strong candidate above threshold', () => {
      const entry = makeEntry({
        recallCount: 10,
        avgScore: 0.95,
        queryHashes: ['q1', 'q2', 'q3', 'q4', 'q5'],
        recallDays: [
          '2026-04-01',
          '2026-04-02',
          '2026-04-03',
          '2026-04-04',
          '2026-04-05',
        ],
        conceptTags: ['trading', 'strategy', 'momentum', 'llm', 'crypto'],
      });

      const result = scoreCandidate(entry);

      expect(result.score).toBeGreaterThan(DEFAULT_THRESHOLDS.minScore);
      expect(result.promoted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('rejects candidate with low recall count', () => {
      const entry = makeEntry({
        recallCount: 1,
        queryHashes: ['q1'],
      });

      const result = scoreCandidate(entry);

      expect(result.promoted).toBe(false);
      // May fail on score threshold or recall count — either is correct
      expect(result.reason).toBeTruthy();
    });

    it('rejects candidate with too few unique queries when score passes', () => {
      // Score must pass threshold, but queryHashes < minUniqueQueries
      // Use custom thresholds with lower minScore to isolate the UniqueQueries gate
      const entry = makeEntry({
        recallCount: 10,
        avgScore: 0.99,
        queryHashes: ['q1'], // only 1, need 2
        recallDays: [
          '2026-04-01',
          '2026-04-02',
          '2026-04-03',
          '2026-04-04',
          '2026-04-05',
        ],
        conceptTags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      });

      const result = scoreCandidate(entry, DEFAULT_WEIGHTS, {
        ...DEFAULT_THRESHOLDS,
        minScore: 0.5, // lower score threshold to ensure we hit UniqueQueries gate
      });

      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('UniqueQueries');
    });

    it('rejects candidate that is too old', () => {
      const entry = makeEntry({
        firstSeen: new Date(
          Date.now() - 60 * 24 * 60 * 60 * 1000,
        ).toISOString(), // 60 days ago
      });

      const result = scoreCandidate(entry);

      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Too old');
    });

    it('gives higher score to recently recalled entries', () => {
      const recent = makeEntry({
        lastRecalled: new Date().toISOString(),
      });
      const stale = makeEntry({
        contentHash: 'def456',
        lastRecalled: new Date(
          Date.now() - 20 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });

      const recentScore = scoreCandidate(recent);
      const staleScore = scoreCandidate(stale);

      expect(recentScore.breakdown.recency).toBeGreaterThan(
        staleScore.breakdown.recency,
      );
    });

    it('returns score between 0 and 1', () => {
      const entry = makeEntry();
      const result = scoreCandidate(entry);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    });

    it('breakdown components sum with weights to equal score', () => {
      const entry = makeEntry();
      const result = scoreCandidate(entry);

      const recomputed =
        DEFAULT_WEIGHTS.frequency * result.breakdown.frequency +
        DEFAULT_WEIGHTS.relevance * result.breakdown.relevance +
        DEFAULT_WEIGHTS.diversity * result.breakdown.diversity +
        DEFAULT_WEIGHTS.recency * result.breakdown.recency +
        DEFAULT_WEIGHTS.consolidation * result.breakdown.consolidation +
        DEFAULT_WEIGHTS.conceptual * result.breakdown.conceptual;

      expect(result.score).toBeCloseTo(recomputed, 10);
    });

    it('uses custom weights when provided', () => {
      const entry = makeEntry();
      const customWeights = {
        frequency: 1.0,
        relevance: 0,
        diversity: 0,
        recency: 0,
        consolidation: 0,
        conceptual: 0,
      };

      const result = scoreCandidate(entry, customWeights, DEFAULT_THRESHOLDS);

      expect(result.score).toBeCloseTo(result.breakdown.frequency, 10);
    });
  });

  describe('rankCandidates', () => {
    it('returns candidates sorted by score descending', () => {
      const entries = [
        makeEntry({
          contentHash: 'weak',
          recallCount: 1,
          queryHashes: ['q1'],
          avgScore: 0.3,
        }),
        makeEntry({
          contentHash: 'strong',
          recallCount: 15,
          queryHashes: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'],
          avgScore: 0.95,
        }),
        makeEntry({
          contentHash: 'medium',
          recallCount: 5,
          queryHashes: ['q1', 'q2', 'q3'],
          avgScore: 0.7,
        }),
      ];

      const ranked = rankCandidates(entries);

      expect(ranked[0].entry.contentHash).toBe('strong');
      expect(ranked[ranked.length - 1].entry.contentHash).toBe('weak');
      for (let i = 1; i < ranked.length; i++) {
        expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
      }
    });

    it('marks only qualifying candidates as promoted', () => {
      const entries = [
        makeEntry({
          contentHash: 'good',
          recallCount: 15,
          queryHashes: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'],
          avgScore: 0.98,
          recallDays: [
            '2026-04-01',
            '2026-04-02',
            '2026-04-03',
            '2026-04-04',
            '2026-04-05',
          ],
          conceptTags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        }),
        makeEntry({
          contentHash: 'bad',
          recallCount: 1,
          queryHashes: ['q1'],
          avgScore: 0.2,
        }),
      ];

      const ranked = rankCandidates(entries);
      const promoted = ranked.filter((r) => r.promoted);
      const rejected = ranked.filter((r) => !r.promoted);

      expect(promoted.length).toBeGreaterThanOrEqual(1);
      expect(rejected.length).toBeGreaterThanOrEqual(1);
    });

    it('handles empty array', () => {
      const ranked = rankCandidates([]);
      expect(ranked).toHaveLength(0);
    });
  });
});
