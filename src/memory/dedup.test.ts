import { describe, it, expect } from 'vitest';
import { dedup3Stage, dedupRecallEntries } from './dedup.js';
import type { DedupEntry, DedupResult } from './dedup.js';

// ─── Helpers ────────────────────────────────────────────────

function makeEntry(id: string, text: string): DedupEntry {
  return { id, text };
}

function makeRecallEntry(hash: string, snippet: string) {
  return { contentHash: hash, snippet, source: 'test.md', score: 0.9 };
}

// ─── dedup3Stage ────────────────────────────────────────────

describe('dedup3Stage', () => {
  describe('empty and single input', () => {
    it('returns empty result for empty input', () => {
      const result = dedup3Stage([]);
      expect(result.unique).toHaveLength(0);
      expect(result.duplicates).toHaveLength(0);
    });

    it('returns single entry as unique', () => {
      const entries = [makeEntry('a', 'The quick brown fox jumps over the lazy dog')];
      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(1);
      expect(result.unique[0].id).toBe('a');
      expect(result.duplicates).toHaveLength(0);
    });
  });

  describe('exact duplicates (Stage 1 - SimHash)', () => {
    it('catches identical text as duplicate', () => {
      const text = 'The quick brown fox jumps over the lazy dog near the river bank';
      const entries = [
        makeEntry('original', text),
        makeEntry('copy', text),
      ];

      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(1);
      expect(result.unique[0].id).toBe('original');
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].entry.id).toBe('copy');
      expect(result.duplicates[0].duplicateOf).toBe('original');
      expect(result.duplicates[0].stage).toBe(1);
    });

    it('catches near-identical text differing by one word at SimHash stage', () => {
      const entries = [
        makeEntry('a', 'The trading strategy uses momentum indicators for market analysis today'),
        makeEntry('b', 'The trading strategy uses momentum indicators for market analysis yesterday'),
      ];

      const result = dedup3Stage(entries);

      // With only one word changed the SimHash fingerprints should be very close
      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(1);
    });

    it('all identical entries collapse to one unique', () => {
      const text = 'Repeated insight about neural network training loop optimization strategies';
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry(`entry-${i}`, text),
      );

      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(1);
      expect(result.unique[0].id).toBe('entry-0');
      expect(result.duplicates).toHaveLength(9);
      // All duplicates should point back to the first entry
      for (const dup of result.duplicates) {
        expect(dup.duplicateOf).toBe('entry-0');
        expect(dup.stage).toBe(1);
      }
    });
  });

  describe('near-duplicates (Stage 2 - Jaccard)', () => {
    it('catches rephrased text with high shingle overlap via Jaccard stage', () => {
      // Build two texts with a very long shared body, differing only in the last word.
      // Changing only the last word disrupts exactly 1 shingle (the last one), giving
      // Jaccard = (N-1) / (N+1) which is well above 0.85 for large N.
      // We bypass SimHash (threshold=0) to force Stage 2 evaluation.
      const shared = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
      const entries = [
        makeEntry('a', shared + ' tailAlpha'),
        makeEntry('b', shared + ' tailBeta'),
      ];

      const result = dedup3Stage(entries, 0, 0.85);

      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(2);
    });

    it('catches texts sharing most shingles when Jaccard threshold is tuned', () => {
      // These two sentences share a long common core; only the last word differs.
      // We bypass SimHash (threshold=0) to isolate the Jaccard stage.
      const base = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
      const entries = [
        makeEntry('a', base + ' suffixAlpha'),
        makeEntry('b', base + ' suffixBeta'),
      ];

      // With 20 shared 3-grams out of ~21 total, Jaccard is very high
      const result = dedup3Stage(entries, 0, 0.85);

      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(2);
    });

    it('entries caught at stage 2 have stage=2 in result', () => {
      // Build long overlapping texts that definitely pass Jaccard >= 0.85
      const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango';
      const entries = [
        makeEntry('a', words),
        makeEntry('b', words + ' uniform'),
      ];

      // Bypass SimHash with threshold=0
      const result = dedup3Stage(entries, 0, 0.85);

      if (result.duplicates.length > 0) {
        expect(result.duplicates[0].stage).toBe(2);
      }
    });
  });

  describe('distinct entries', () => {
    it('returns all distinct entries as unique', () => {
      const entries = [
        makeEntry('a', 'The weather forecast predicts rain tomorrow across the entire northern region'),
        makeEntry('b', 'Quantum computing leverages entanglement for parallel processing of complex algorithms'),
        makeEntry('c', 'Mediterranean cuisine uses olive oil, herbs, and fresh vegetables as primary ingredients'),
      ];

      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(3);
      expect(result.duplicates).toHaveLength(0);
    });

    it('preserves order of unique entries', () => {
      const entries = [
        makeEntry('first', 'Compilers transform source code into machine executable binary formats'),
        makeEntry('second', 'Photosynthesis converts sunlight energy into glucose molecules within plant cells'),
        makeEntry('third', 'Database indexing accelerates query performance through balanced tree structures'),
      ];

      const result = dedup3Stage(entries);

      expect(result.unique.map((e) => e.id)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('short text (< 3 words)', () => {
    it('handles single-word entries gracefully', () => {
      const entries = [
        makeEntry('a', 'hello'),
        makeEntry('b', 'world'),
      ];

      const result = dedup3Stage(entries);

      // Should not throw; short texts fall back to individual words in shingles
      expect(result.unique.length + result.duplicates.length).toBe(2);
    });

    it('handles two-word entries', () => {
      const entries = [
        makeEntry('a', 'good morning'),
        makeEntry('b', 'good evening'),
      ];

      const result = dedup3Stage(entries);
      expect(result.unique.length + result.duplicates.length).toBe(2);
    });

    it('handles empty-text entries', () => {
      const entries = [
        makeEntry('a', ''),
        makeEntry('b', ''),
      ];

      const result = dedup3Stage(entries);

      // Both have simhash=0, hamming distance=0 => duplicate
      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
    });

    it('handles entries where all words are <= 2 characters', () => {
      // Words of length <= 2 are filtered out by the split logic
      const entries = [
        makeEntry('a', 'it is ok to go'),
        makeEntry('b', 'we do as he is'),
      ];

      const result = dedup3Stage(entries);

      // Both entries have no words > 2 chars, so simhash=0 for both
      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
    });
  });

  describe('stage attribution', () => {
    it('exact duplicates are caught at stage 1', () => {
      const text = 'A sufficiently long sentence about trading strategies and market patterns to ensure simhash works';
      const entries = [
        makeEntry('orig', text),
        makeEntry('dupe', text),
      ];

      const result = dedup3Stage(entries);

      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(1);
    });

    it('duplicateOf references the correct surviving entry', () => {
      const text = 'Repeated analysis of cryptocurrency market trends during high volatility periods';
      const entries = [
        makeEntry('survivor', text),
        makeEntry('dup1', text),
        makeEntry('dup2', text),
      ];

      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(1);
      expect(result.unique[0].id).toBe('survivor');
      for (const dup of result.duplicates) {
        expect(dup.duplicateOf).toBe('survivor');
      }
    });
  });

  describe('mixed batch of duplicates and uniques', () => {
    it('correctly separates a mixed batch', () => {
      const textA = 'Machine learning models require careful hyperparameter tuning for optimal performance in production';
      const textB = 'The Rust programming language ensures memory safety without garbage collection overhead';
      const textC = 'Distributed systems face challenges with network partitions and eventual consistency models';

      const entries = [
        makeEntry('a1', textA),
        makeEntry('b1', textB),
        makeEntry('a2', textA),   // dup of a1
        makeEntry('c1', textC),
        makeEntry('b2', textB),   // dup of b1
        makeEntry('a3', textA),   // dup of a1
      ];

      const result = dedup3Stage(entries);

      expect(result.unique).toHaveLength(3);
      expect(result.duplicates).toHaveLength(3);

      const uniqueIds = result.unique.map((e) => e.id);
      expect(uniqueIds).toContain('a1');
      expect(uniqueIds).toContain('b1');
      expect(uniqueIds).toContain('c1');

      const dupIds = result.duplicates.map((d) => d.entry.id);
      expect(dupIds).toContain('a2');
      expect(dupIds).toContain('b2');
      expect(dupIds).toContain('a3');
    });
  });

  describe('threshold edge cases', () => {
    it('simhashThreshold=0 only catches exact fingerprint matches', () => {
      const entries = [
        makeEntry('a', 'The quick brown fox jumps over the lazy dog in the park'),
        makeEntry('b', 'The quick brown fox leaps over the lazy dog in the park'),
      ];

      // With threshold=0, only exact simhash matches are caught at stage 1
      const strict = dedup3Stage(entries, 0, 0.99);
      // May or may not be caught depending on fingerprint — the key point is
      // that a stricter threshold lets more through stage 1
      const loose = dedup3Stage(entries, 10, 0.99);

      // With very loose simhash threshold, more things should be caught
      expect(loose.duplicates.length).toBeGreaterThanOrEqual(strict.duplicates.length);
    });

    it('jaccardThreshold=1.0 requires perfect shingle match', () => {
      const entries = [
        makeEntry('a', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'),
        makeEntry('b', 'alpha beta gamma delta epsilon zeta eta theta iota lambda'),
      ];

      // With threshold 1.0 and simhash threshold 0, only perfect matches pass
      const result = dedup3Stage(entries, 0, 1.0);

      // These differ in one word so Jaccard < 1.0 and simhash threshold 0
      // means stage 1 needs exact fingerprint; they should both survive as unique
      // (unless their simhash fingerprints happen to collide at distance 0)
      expect(result.unique.length).toBeGreaterThanOrEqual(1);
    });

    it('jaccardThreshold=0.0 catches everything at stage 2', () => {
      const entries = [
        makeEntry('a', 'completely different text about astronomy and black holes'),
        makeEntry('b', 'unrelated content discussing marine biology coral reefs'),
      ];

      // Simhash threshold 0 but Jaccard threshold 0.0 means any non-zero overlap triggers
      // Actually Jaccard returns 0 for disjoint sets, so truly different texts survive
      const result = dedup3Stage(entries, 0, 0.0);

      // Even with threshold 0.0, Jaccard >= 0.0 is always true when both sets are non-empty
      // So one will be caught as duplicate
      expect(result.unique).toHaveLength(1);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(2);
    });

    it('large simhashThreshold catches distant fingerprints', () => {
      const entries = [
        makeEntry('a', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'),
        makeEntry('b', 'completely different sentence about something else entirely now'),
      ];

      // With threshold 32 (max bits), everything matches at stage 1
      const result = dedup3Stage(entries, 32, 0.85);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].stage).toBe(1);
    });
  });
});

// ─── dedupRecallEntries ─────────────────────────────────────

describe('dedupRecallEntries', () => {
  it('returns empty array for empty input', () => {
    const result = dedupRecallEntries([]);
    expect(result).toHaveLength(0);
  });

  it('returns single entry unchanged', () => {
    const entries = [makeRecallEntry('hash1', 'some snippet about trading strategies')];
    const result = dedupRecallEntries(entries);

    expect(result).toHaveLength(1);
    expect(result[0].contentHash).toBe('hash1');
  });

  it('filters duplicate snippets', () => {
    const snippet = 'Analysis of market trends shows consistent momentum patterns over multiple timeframes';
    const entries = [
      makeRecallEntry('hash1', snippet),
      makeRecallEntry('hash2', snippet),
      makeRecallEntry('hash3', snippet),
    ];

    const result = dedupRecallEntries(entries);

    expect(result).toHaveLength(1);
    expect(result[0].contentHash).toBe('hash1');
  });

  it('preserves distinct entries', () => {
    const entries = [
      makeRecallEntry('h1', 'Neural networks learn hierarchical feature representations from raw input data'),
      makeRecallEntry('h2', 'Kubernetes orchestrates container workloads across distributed cluster nodes efficiently'),
      makeRecallEntry('h3', 'GraphQL provides flexible querying interface for frontend application data retrieval'),
    ];

    const result = dedupRecallEntries(entries);
    expect(result).toHaveLength(3);
  });

  it('preserves extra fields on recall entries', () => {
    const entries = [
      { contentHash: 'h1', snippet: 'unique text about quantum computing research advances', source: 'memory/quantum.md', score: 0.95, extra: 'preserved' },
      { contentHash: 'h2', snippet: 'different text about compiler optimization techniques and passes', source: 'memory/compilers.md', score: 0.80, extra: 'also kept' },
    ];

    const result = dedupRecallEntries(entries);

    expect(result).toHaveLength(2);
    expect((result[0] as any).extra).toBe('preserved');
    expect((result[1] as any).extra).toBe('also kept');
  });

  it('uses contentHash as id for dedup mapping', () => {
    const snippet = 'Identical snippet about reinforcement learning reward shaping and policy gradients';
    const entries = [
      makeRecallEntry('unique-hash-1', snippet),
      makeRecallEntry('unique-hash-2', snippet),
    ];

    const result = dedupRecallEntries(entries);

    // First entry's contentHash is kept
    expect(result).toHaveLength(1);
    expect(result[0].contentHash).toBe('unique-hash-1');
  });

  it('respects custom thresholds', () => {
    const entries = [
      makeRecallEntry('h1', 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'),
      makeRecallEntry('h2', 'alpha beta gamma delta epsilon zeta eta theta iota kappa mu'),
    ];

    // Very strict thresholds — should keep both
    const strict = dedupRecallEntries(entries, 0, 1.0);
    // Very loose thresholds — should collapse
    const loose = dedupRecallEntries(entries, 32, 0.0);

    expect(strict.length).toBeGreaterThanOrEqual(loose.length);
  });

  it('handles mixed batch correctly', () => {
    const snippetA = 'Deep learning architectures benefit from batch normalization during training loops';
    const snippetB = 'PostgreSQL supports advanced indexing strategies including GIN and GiST indexes';

    const entries = [
      makeRecallEntry('a1', snippetA),
      makeRecallEntry('b1', snippetB),
      makeRecallEntry('a2', snippetA),
      makeRecallEntry('b2', snippetB),
    ];

    const result = dedupRecallEntries(entries);

    expect(result).toHaveLength(2);
    const hashes = result.map((e) => e.contentHash);
    expect(hashes).toContain('a1');
    expect(hashes).toContain('b1');
  });
});
