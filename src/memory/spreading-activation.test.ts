import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeKnowledgeGraphHandles,
  buildGraph,
} from './knowledge-graph.js';
import {
  _closeSpreadingActivationHandles,
  spreadActivation,
  enhanceWithActivation,
} from './spreading-activation.js';

// ─── Helpers ────────────────────────────────────────────────

let tmpDir: string;

function dreamsDir(): string {
  return path.join(tmpDir, '.dreams');
}

function dbPath(): string {
  return path.join(dreamsDir(), 'knowledge-graph.db');
}

/** Write a markdown file with wikilinks in a scannable directory. */
function writeMemoryFile(name: string, content: string): void {
  const memDir = path.join(tmpDir, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, name), content);
}

/**
 * Set up a simple graph:
 *
 *   Alice -- Bob -- Charlie -- Dave
 *                     |
 *                   Eve
 *
 * Files co-mention pairs to create edges.
 */
function setupLinearGraph(): void {
  writeMemoryFile(
    'ab.md',
    'Meeting with [[Alice]] and [[Bob]] about the project',
  );
  writeMemoryFile('bc.md', '[[Bob]] and [[Charlie]] worked on the API');
  writeMemoryFile('cd.md', '[[Charlie]] handed off to [[Dave]] for review');
  writeMemoryFile('ce.md', '[[Charlie]] and [[Eve]] discussed testing');
  buildGraph(tmpDir);
}

/**
 * Set up a denser graph:
 *
 *   Alpha -- Beta -- Gamma
 *     |        |
 *   Delta -- Epsilon
 *
 * Multiple connections create richer spreading paths.
 */
function setupDenseGraph(): void {
  writeMemoryFile('ab.md', '[[Alpha]] relates to [[Beta]] in design');
  writeMemoryFile('bg.md', '[[Beta]] leads to [[Gamma]] in implementation');
  writeMemoryFile('ad.md', '[[Alpha]] and [[Delta]] are connected');
  writeMemoryFile('be.md', '[[Beta]] and [[Epsilon]] share context');
  writeMemoryFile('de.md', '[[Delta]] and [[Epsilon]] co-occur');
  buildGraph(tmpDir);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spreading-test-'));
});

afterEach(() => {
  _closeKnowledgeGraphHandles();
  _closeSpreadingActivationHandles();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── spreadActivation ───────────────────────────────────────

describe('spreadActivation', () => {
  it('returns empty for empty seeds', () => {
    setupLinearGraph();
    const results = spreadActivation(tmpDir, []);
    expect(results).toHaveLength(0);
  });

  it('returns empty when DB does not exist', () => {
    // No graph built — DB file missing
    const results = spreadActivation(tmpDir, ['Alice']);
    expect(results).toEqual([]);
  });

  it('returns empty for non-existent directory', () => {
    const results = spreadActivation('/tmp/nonexistent-dir-xyz', ['Alice']);
    expect(results).toEqual([]);
  });

  it('seeds get activation=1.0 and hops=0', () => {
    setupLinearGraph();
    const results = spreadActivation(tmpDir, ['Alice']);
    const alice = results.find((r) => r.entity === 'alice');
    expect(alice).toBeDefined();
    expect(alice!.activation).toBe(1.0);
    expect(alice!.hops).toBe(0);
  });

  it('direct neighbor gets activation at hop 1 with decay applied', () => {
    setupLinearGraph();
    // Alice -- Bob: Bob should be at hop 1 with activation = 0.7
    const results = spreadActivation(tmpDir, ['Alice'], 2, 0.7);
    const bob = results.find((r) => r.entity === 'bob');
    expect(bob).toBeDefined();
    expect(bob!.hops).toBe(1);
    expect(bob!.activation).toBeCloseTo(0.7, 5);
  });

  it('applies decay factor correctly: 0.7^1 and 0.7^2', () => {
    setupLinearGraph();
    // Alice -- Bob -- Charlie
    const results = spreadActivation(tmpDir, ['Alice'], 2, 0.7);

    const alice = results.find((r) => r.entity === 'alice');
    const bob = results.find((r) => r.entity === 'bob');
    const charlie = results.find((r) => r.entity === 'charlie');

    expect(alice!.activation).toBe(1.0);
    expect(bob!.activation).toBeCloseTo(0.7, 5); // 0.7^1
    expect(charlie!.activation).toBeCloseTo(0.49, 5); // 0.7^2
  });

  it('maxHops=1 limits to direct neighbors only', () => {
    setupLinearGraph();
    // Alice -- Bob -- Charlie: with maxHops=1, Charlie should not appear
    const results = spreadActivation(tmpDir, ['Alice'], 1, 0.7);

    const alice = results.find((r) => r.entity === 'alice');
    const bob = results.find((r) => r.entity === 'bob');
    const charlie = results.find((r) => r.entity === 'charlie');

    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(charlie).toBeUndefined();
  });

  it('minActivation filters out low-activation nodes', () => {
    setupLinearGraph();
    // Alice(1.0) -- Bob(0.7) -- Charlie(0.49) -- Dave(0.343)
    // With minActivation=0.5, Dave (0.343) and Charlie (0.49) should be filtered
    const results = spreadActivation(tmpDir, ['Alice'], 3, 0.7, 0.5);

    const alice = results.find((r) => r.entity === 'alice');
    const bob = results.find((r) => r.entity === 'bob');
    const charlie = results.find((r) => r.entity === 'charlie');
    const dave = results.find((r) => r.entity === 'dave');

    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    // Charlie has 0.49 < 0.5 threshold → filtered
    expect(charlie).toBeUndefined();
    expect(dave).toBeUndefined();
  });

  it('results are sorted by activation descending', () => {
    setupLinearGraph();
    const results = spreadActivation(tmpDir, ['Alice'], 3, 0.7, 0.1);

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].activation).toBeGreaterThanOrEqual(
        results[i].activation,
      );
    }
  });

  it('multiple seeds each get activation=1.0', () => {
    setupLinearGraph();
    const results = spreadActivation(tmpDir, ['Alice', 'Dave'], 1, 0.7);

    const alice = results.find((r) => r.entity === 'alice');
    const dave = results.find((r) => r.entity === 'dave');

    expect(alice!.activation).toBe(1.0);
    expect(alice!.hops).toBe(0);
    expect(dave!.activation).toBe(1.0);
    expect(dave!.hops).toBe(0);
  });

  it('seeds are case-insensitive', () => {
    setupLinearGraph();
    const resultsLower = spreadActivation(tmpDir, ['alice'], 1, 0.7);
    const resultsUpper = spreadActivation(tmpDir, ['Alice'], 1, 0.7);
    const resultsMixed = spreadActivation(tmpDir, ['ALICE'], 1, 0.7);

    // All should find the same seed
    expect(resultsLower.find((r) => r.entity === 'alice')).toBeDefined();
    expect(resultsUpper.find((r) => r.entity === 'alice')).toBeDefined();
    expect(resultsMixed.find((r) => r.entity === 'alice')).toBeDefined();
  });

  it('uses default parameters (maxHops=2, decay=0.7, minActivation=0.1)', () => {
    setupLinearGraph();
    // With defaults: Alice(1.0) -- Bob(0.7) -- Charlie(0.49)
    // Charlie at hop 2 with 0.49 >= 0.1 → included
    const results = spreadActivation(tmpDir, ['Alice']);

    const alice = results.find((r) => r.entity === 'alice');
    const bob = results.find((r) => r.entity === 'bob');
    const charlie = results.find((r) => r.entity === 'charlie');

    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(charlie).toBeDefined();
  });

  it('spreads through branching paths', () => {
    setupDenseGraph();
    // Alpha -- Beta, Alpha -- Delta
    // Seeding Alpha should reach both Beta and Delta at hop 1
    const results = spreadActivation(tmpDir, ['Alpha'], 1, 0.7);

    const beta = results.find((r) => r.entity === 'beta');
    const delta = results.find((r) => r.entity === 'delta');

    expect(beta).toBeDefined();
    expect(delta).toBeDefined();
    expect(beta!.hops).toBe(1);
    expect(delta!.hops).toBe(1);
  });

  it('picks higher activation when node reachable by multiple paths', () => {
    setupDenseGraph();
    // Alpha -- Beta -- Epsilon (hop 2, activation 0.49)
    // Alpha -- Delta -- Epsilon (hop 2, activation 0.49)
    // Epsilon is reachable from two paths at equal distance — activation should be 0.49
    const results = spreadActivation(tmpDir, ['Alpha'], 2, 0.7);
    const epsilon = results.find((r) => r.entity === 'epsilon');

    expect(epsilon).toBeDefined();
    expect(epsilon!.activation).toBeCloseTo(0.49, 5);
  });

  it('non-existent seed entity still returns with activation 1.0', () => {
    setupLinearGraph();
    const results = spreadActivation(tmpDir, ['NonExistentEntity']);
    // The seed is added to activations map with 1.0, even if not in DB
    // But it won't have any neighbors, so no spreading occurs
    const seed = results.find((r) => r.entity === 'nonexistententity');
    expect(seed).toBeDefined();
    expect(seed!.activation).toBe(1.0);
    expect(results).toHaveLength(1);
  });
});

// ─── enhanceWithActivation ──────────────────────────────────

describe('enhanceWithActivation', () => {
  it('boosts results containing activated entities', () => {
    setupLinearGraph();
    const results = [
      { content: 'Alice worked on the frontend', score: 0.5 },
      { content: 'Random unrelated content', score: 0.5 },
    ];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results);

    // Result mentioning Alice should get a boost
    const aliceResult = enhanced.find((r) => r.content.includes('Alice'));
    const randomResult = enhanced.find((r) => r.content.includes('Random'));

    expect(aliceResult!.score).toBeGreaterThan(0.5);
    expect(aliceResult!.activationBoost).toBeGreaterThan(0);

    // Random result should have no boost
    expect(randomResult!.score).toBe(0.5);
    expect(randomResult!.activationBoost).toBe(0);
  });

  it('returns results with no boost when queryEntities is empty', () => {
    setupLinearGraph();
    const results = [
      { content: 'Alice did something', score: 0.7 },
      { content: 'Bob did something', score: 0.3 },
    ];

    const enhanced = enhanceWithActivation(tmpDir, [], results);

    expect(enhanced).toHaveLength(2);
    expect(enhanced[0].score).toBe(0.7);
    expect(enhanced[0].activationBoost).toBe(0);
    expect(enhanced[1].score).toBe(0.3);
    expect(enhanced[1].activationBoost).toBe(0);
  });

  it('returns results with no boost when no entities appear in content', () => {
    setupLinearGraph();
    const results = [
      { content: 'Completely unrelated topic about weather', score: 0.5 },
      { content: 'Another unrelated document about cooking', score: 0.4 },
    ];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results);

    for (const r of enhanced) {
      expect(r.activationBoost).toBe(0);
    }
  });

  it('boostWeight controls the magnitude of the boost', () => {
    setupLinearGraph();
    const results = [{ content: 'Alice and the project', score: 0.5 }];

    const lowBoost = enhanceWithActivation(tmpDir, ['Alice'], results, 0.1);
    const highBoost = enhanceWithActivation(tmpDir, ['Alice'], results, 0.5);

    expect(highBoost[0].activationBoost).toBeGreaterThan(
      lowBoost[0].activationBoost,
    );
    // With activation=1.0 for Alice (seed), boost = 1.0 * weight
    expect(lowBoost[0].activationBoost).toBeCloseTo(0.1, 5);
    expect(highBoost[0].activationBoost).toBeCloseTo(0.5, 5);
  });

  it('uses default boostWeight of 0.15', () => {
    setupLinearGraph();
    const results = [{ content: 'Alice is mentioned here', score: 0.5 }];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results);
    // Alice is a seed (activation=1.0), so boost = 1.0 * 0.15 = 0.15
    expect(enhanced[0].activationBoost).toBeCloseTo(0.15, 5);
    expect(enhanced[0].score).toBeCloseTo(0.65, 5);
  });

  it('spreading reaches indirect entities in content', () => {
    setupLinearGraph();
    // Alice -- Bob: Bob should have activation 0.7
    const results = [{ content: 'Bob reviewed the code', score: 0.5 }];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results, 0.15);

    // Bob gets activation=0.7 from spreading; boost = 0.7 * 0.15 = 0.105
    expect(enhanced[0].activationBoost).toBeCloseTo(0.7 * 0.15, 2);
    expect(enhanced[0].score).toBeGreaterThan(0.5);
  });

  it('picks maximum activation when multiple entities appear in content', () => {
    setupLinearGraph();
    // Seed Alice (1.0); Bob gets 0.7 via spreading
    const results = [
      { content: 'Alice and Bob collaborated together', score: 0.5 },
    ];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results, 0.15);

    // maxBoost should be from Alice (1.0), not Bob (0.7)
    expect(enhanced[0].activationBoost).toBeCloseTo(1.0 * 0.15, 5);
  });

  it('handles case-insensitive entity matching in content', () => {
    setupLinearGraph();
    // Content uses lowercase 'alice', entities stored as 'Alice'
    // spreadActivation normalizes to lowercase, so matching should work
    const results = [{ content: 'alice was here', score: 0.5 }];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results, 0.15);
    expect(enhanced[0].activationBoost).toBeCloseTo(0.15, 5);
  });

  it('returns all original result fields plus activationBoost', () => {
    setupLinearGraph();
    const results = [{ content: 'Some content', score: 0.42 }];

    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results);

    expect(enhanced[0]).toHaveProperty('content', 'Some content');
    expect(enhanced[0]).toHaveProperty('score');
    expect(enhanced[0]).toHaveProperty('activationBoost');
  });

  it('handles empty results array', () => {
    setupLinearGraph();
    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], []);
    expect(enhanced).toEqual([]);
  });

  it('works when DB does not exist (no boost applied)', () => {
    // No graph built
    const results = [{ content: 'Alice content', score: 0.5 }];
    const enhanced = enhanceWithActivation(tmpDir, ['Alice'], results);
    // spreadActivation returns [] when no DB, so no boosts
    expect(enhanced[0].activationBoost).toBe(0);
    expect(enhanced[0].score).toBe(0.5);
  });
});
