import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecallEntry } from './recall-tracker.js';
import type { HierarchyStore, TopicCluster } from './hierarchy.js';
import {
  clusterEntries,
  buildTopics,
  buildGlobals,
  retrieveAtLevel,
  loadHierarchy,
  saveHierarchy,
} from './hierarchy.js';

// ─── Helpers ────────────────────────────────────────────────

let tmpDir: string;

function dreamsDir(): string {
  return path.join(tmpDir, '.dreams');
}

function hierarchyPath(): string {
  return path.join(dreamsDir(), 'hierarchy.json');
}

function makeEntry(
  overrides: Partial<RecallEntry> & { contentHash: string },
): RecallEntry {
  return {
    source: 'memory/test.md',
    recallCount: 1,
    queryHashes: ['q1'],
    recallDays: ['2026-01-01'],
    conceptTags: [],
    avgScore: 0.5,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastRecalled: '2026-01-01T00:00:00.000Z',
    snippet: `Snippet for ${overrides.contentHash}`,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hierarchy-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── loadHierarchy / saveHierarchy ──────────────────────────

describe('loadHierarchy', () => {
  it('returns default store when no file exists', () => {
    const store = loadHierarchy(tmpDir);
    expect(store.version).toBe(1);
    expect(store.topics).toEqual([]);
    expect(store.globals).toEqual([]);
    expect(store.lastUpdated).toBeDefined();
  });

  it('returns default store when file is corrupted', () => {
    fs.mkdirSync(dreamsDir(), { recursive: true });
    fs.writeFileSync(hierarchyPath(), '{ not valid json ]]');
    const store = loadHierarchy(tmpDir);
    expect(store.version).toBe(1);
    expect(store.topics).toEqual([]);
  });

  it('loads existing store from disk', () => {
    const saved: HierarchyStore = {
      version: 1,
      topics: [
        {
          id: 'topic-1',
          level: 'topic',
          tags: ['alpha', 'beta'],
          entries: ['hash1'],
          summary: 'Test topic',
          importance: 0.8,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      globals: [],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(dreamsDir(), { recursive: true });
    fs.writeFileSync(hierarchyPath(), JSON.stringify(saved));

    const store = loadHierarchy(tmpDir);
    expect(store.topics).toHaveLength(1);
    expect(store.topics[0].id).toBe('topic-1');
    expect(store.topics[0].tags).toEqual(['alpha', 'beta']);
  });
});

describe('saveHierarchy', () => {
  it('creates .dreams directory if missing', () => {
    const store: HierarchyStore = {
      version: 1,
      topics: [],
      globals: [],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    saveHierarchy(tmpDir, store);
    expect(fs.existsSync(hierarchyPath())).toBe(true);
  });

  it('persists store to disk and updates lastUpdated', () => {
    const store: HierarchyStore = {
      version: 1,
      topics: [
        {
          id: 'topic-x',
          level: 'topic',
          tags: ['x'],
          entries: ['h1'],
          summary: 'X',
          importance: 0.5,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      globals: [],
      lastUpdated: '2020-01-01T00:00:00.000Z',
    };
    saveHierarchy(tmpDir, store);

    const loaded = JSON.parse(fs.readFileSync(hierarchyPath(), 'utf-8'));
    expect(loaded.topics).toHaveLength(1);
    expect(loaded.topics[0].id).toBe('topic-x');
    // lastUpdated should be refreshed (not the old 2020 value)
    expect(loaded.lastUpdated).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('round-trips through save and load', () => {
    const store: HierarchyStore = {
      version: 1,
      topics: [
        {
          id: 'rt-1',
          level: 'topic',
          tags: ['round', 'trip'],
          entries: ['h1', 'h2'],
          summary: 'Round trip test',
          importance: 0.9,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      globals: [
        {
          id: 'g-1',
          level: 'global',
          tags: ['global'],
          entries: ['rt-1'],
          summary: 'Global pattern',
          importance: 0.7,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      lastUpdated: '2026-01-01T00:00:00.000Z',
    };
    saveHierarchy(tmpDir, store);
    const loaded = loadHierarchy(tmpDir);

    expect(loaded.topics).toHaveLength(1);
    expect(loaded.topics[0].tags).toEqual(['round', 'trip']);
    expect(loaded.globals).toHaveLength(1);
    expect(loaded.globals[0].tags).toEqual(['global']);
  });
});

// ─── clusterEntries ─────────────────────────────────────────

describe('clusterEntries', () => {
  it('returns empty clusters for empty entries', () => {
    const result = clusterEntries([]);
    expect(result).toEqual([]);
  });

  it('returns single cluster for single entry', () => {
    const entry = makeEntry({
      contentHash: 'h1',
      conceptTags: ['alpha', 'beta'],
    });
    const result = clusterEntries([entry]);
    // Single entry forms its own cluster (members.length === 1, still returned since > 0)
    expect(result).toHaveLength(1);
    expect(result[0].members).toHaveLength(1);
    expect(result[0].tags).toEqual(['alpha', 'beta']);
  });

  it('merges two entries with overlapping tags into one cluster', () => {
    const e1 = makeEntry({
      contentHash: 'h1',
      conceptTags: ['alpha', 'beta', 'gamma'],
    });
    const e2 = makeEntry({
      contentHash: 'h2',
      conceptTags: ['alpha', 'beta', 'delta'],
    });
    // Jaccard: intersection=2 (alpha,beta), union=4 (alpha,beta,gamma,delta) → 0.5 >= 0.4
    const result = clusterEntries([e1, e2]);
    expect(result).toHaveLength(1);
    expect(result[0].members).toHaveLength(2);
    expect(result[0].tags).toContain('alpha');
    expect(result[0].tags).toContain('beta');
    expect(result[0].tags).toContain('gamma');
    expect(result[0].tags).toContain('delta');
  });

  it('keeps two entries with no tag overlap as separate clusters', () => {
    const e1 = makeEntry({ contentHash: 'h1', conceptTags: ['alpha', 'beta'] });
    const e2 = makeEntry({
      contentHash: 'h2',
      conceptTags: ['gamma', 'delta'],
    });
    // Jaccard: 0/4 = 0 → below 0.4 threshold
    const result = clusterEntries([e1, e2]);
    expect(result).toHaveLength(2);
    expect(result[0].members).toHaveLength(1);
    expect(result[1].members).toHaveLength(1);
  });

  it('forms multiple clusters from distinct tag groups', () => {
    // Group A: tags overlap
    const a1 = makeEntry({
      contentHash: 'a1',
      conceptTags: ['react', 'frontend', 'ui'],
    });
    const a2 = makeEntry({
      contentHash: 'a2',
      conceptTags: ['react', 'frontend', 'css'],
    });
    // Group B: different tags
    const b1 = makeEntry({
      contentHash: 'b1',
      conceptTags: ['database', 'postgres', 'sql'],
    });
    const b2 = makeEntry({
      contentHash: 'b2',
      conceptTags: ['database', 'postgres', 'migration'],
    });
    // Group C: yet another cluster
    const c1 = makeEntry({
      contentHash: 'c1',
      conceptTags: ['deploy', 'docker', 'kubernetes'],
    });

    const result = clusterEntries([a1, a2, b1, b2, c1]);
    // Should have 3 clusters (two merged pairs + one singleton)
    expect(result).toHaveLength(3);

    // Verify merged clusters have 2 members each
    const twoMemberClusters = result.filter((c) => c.members.length === 2);
    expect(twoMemberClusters).toHaveLength(2);
  });

  it('uses default threshold of 0.4', () => {
    // Jaccard exactly 0.4: intersection=2, union=5 → 2/5 = 0.4
    const e1 = makeEntry({ contentHash: 'h1', conceptTags: ['a', 'b', 'c'] });
    const e2 = makeEntry({
      contentHash: 'h2',
      conceptTags: ['a', 'b', 'd', 'e'],
    });
    // intersection={a,b}=2, union={a,b,c,d,e}=5 → 2/5=0.4 → should merge
    const result = clusterEntries([e1, e2]);
    expect(result).toHaveLength(1);
    expect(result[0].members).toHaveLength(2);
  });

  it('respects custom threshold: high threshold prevents merging', () => {
    const e1 = makeEntry({ contentHash: 'h1', conceptTags: ['a', 'b', 'c'] });
    const e2 = makeEntry({
      contentHash: 'h2',
      conceptTags: ['a', 'b', 'd', 'e'],
    });
    // Jaccard: 0.4 — below 0.9 threshold
    const result = clusterEntries([e1, e2], 0.9);
    expect(result).toHaveLength(2);
  });

  it('respects custom threshold: low threshold enables merging', () => {
    const e1 = makeEntry({
      contentHash: 'h1',
      conceptTags: ['a', 'b', 'c', 'd'],
    });
    const e2 = makeEntry({
      contentHash: 'h2',
      conceptTags: ['a', 'e', 'f', 'g'],
    });
    // Jaccard: 1/7 ~ 0.14 → below default 0.4 but above 0.1
    const result = clusterEntries([e1, e2], 0.1);
    expect(result).toHaveLength(1);
    expect(result[0].members).toHaveLength(2);
  });

  it('handles entries with empty tags', () => {
    const e1 = makeEntry({ contentHash: 'h1', conceptTags: [] });
    const e2 = makeEntry({ contentHash: 'h2', conceptTags: ['a'] });
    // tagSimilarity returns 0 when either set is empty
    const result = clusterEntries([e1, e2]);
    expect(result).toHaveLength(2);
  });
});

// ─── buildTopics ────────────────────────────────────────────

describe('buildTopics', () => {
  it('creates topic clusters from entries and saves to hierarchy.json', () => {
    const entries = [
      makeEntry({
        contentHash: 'h1',
        conceptTags: ['api', 'rest', 'http'],
        avgScore: 0.8,
        snippet: 'REST API design patterns',
      }),
      makeEntry({
        contentHash: 'h2',
        conceptTags: ['api', 'rest', 'json'],
        avgScore: 0.6,
        snippet: 'JSON response formatting',
      }),
    ];
    const topics = buildTopics(tmpDir, entries);

    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(topics[0].level).toBe('topic');
    expect(topics[0].entries).toContain('h1');
    expect(topics[0].entries).toContain('h2');
    expect(topics[0].tags).toContain('api');
    expect(topics[0].tags).toContain('rest');

    // Verify saved to disk
    expect(fs.existsSync(hierarchyPath())).toBe(true);
    const store = JSON.parse(fs.readFileSync(hierarchyPath(), 'utf-8'));
    expect(store.topics.length).toBeGreaterThanOrEqual(1);
  });

  it('filters out singleton clusters (only keeps clusters with 2+ members)', () => {
    const entries = [
      makeEntry({ contentHash: 'h1', conceptTags: ['alpha'] }),
      makeEntry({ contentHash: 'h2', conceptTags: ['beta'] }),
    ];
    // No tag overlap → each forms its own singleton cluster → filtered out
    const topics = buildTopics(tmpDir, entries);
    expect(topics).toHaveLength(0);
  });

  it('topic summary contains top tags', () => {
    const entries = [
      makeEntry({
        contentHash: 'h1',
        conceptTags: ['react', 'hooks', 'state'],
        avgScore: 0.9,
        snippet: 'Using useState and useEffect hooks',
      }),
      makeEntry({
        contentHash: 'h2',
        conceptTags: ['react', 'hooks', 'context'],
        avgScore: 0.7,
        snippet: 'React context providers',
      }),
    ];
    const topics = buildTopics(tmpDir, entries);
    expect(topics).toHaveLength(1);
    // Summary should contain tag names
    expect(topics[0].summary).toContain('react');
    expect(topics[0].summary).toContain('hooks');
  });

  it('topic importance is the average of member avgScores', () => {
    const entries = [
      makeEntry({ contentHash: 'h1', conceptTags: ['x', 'y'], avgScore: 0.8 }),
      makeEntry({ contentHash: 'h2', conceptTags: ['x', 'y'], avgScore: 0.4 }),
    ];
    const topics = buildTopics(tmpDir, entries);
    expect(topics).toHaveLength(1);
    expect(topics[0].importance).toBeCloseTo(0.6, 5);
  });

  it('deduplicates with existing topics by tag overlap > 0.6', () => {
    // First call: creates topic with tags [a, b, c]
    const entries1 = [
      makeEntry({
        contentHash: 'h1',
        conceptTags: ['a', 'b', 'c'],
        avgScore: 0.5,
      }),
      makeEntry({
        contentHash: 'h2',
        conceptTags: ['a', 'b', 'c'],
        avgScore: 0.5,
      }),
    ];
    buildTopics(tmpDir, entries1);
    const storeAfterFirst = loadHierarchy(tmpDir);
    expect(storeAfterFirst.topics).toHaveLength(1);

    // Second call: same tags → should update existing, not create new
    const entries2 = [
      makeEntry({
        contentHash: 'h3',
        conceptTags: ['a', 'b', 'c'],
        avgScore: 0.9,
      }),
      makeEntry({
        contentHash: 'h4',
        conceptTags: ['a', 'b', 'c'],
        avgScore: 0.9,
      }),
    ];
    buildTopics(tmpDir, entries2);
    const storeAfterSecond = loadHierarchy(tmpDir);

    // Still 1 topic (updated, not duplicated)
    expect(storeAfterSecond.topics).toHaveLength(1);
    // Entries should be merged
    const entries = storeAfterSecond.topics[0].entries;
    expect(entries).toContain('h1');
    expect(entries).toContain('h2');
    expect(entries).toContain('h3');
    expect(entries).toContain('h4');
  });

  it('creates separate topic when tag overlap is <= 0.6', () => {
    const entries1 = [
      makeEntry({
        contentHash: 'h1',
        conceptTags: ['a', 'b', 'c', 'd'],
        avgScore: 0.5,
      }),
      makeEntry({
        contentHash: 'h2',
        conceptTags: ['a', 'b', 'c', 'd'],
        avgScore: 0.5,
      }),
    ];
    buildTopics(tmpDir, entries1);

    // Tags with low overlap to existing
    const entries2 = [
      makeEntry({
        contentHash: 'h3',
        conceptTags: ['x', 'y', 'z', 'w'],
        avgScore: 0.5,
      }),
      makeEntry({
        contentHash: 'h4',
        conceptTags: ['x', 'y', 'z', 'w'],
        avgScore: 0.5,
      }),
    ];
    buildTopics(tmpDir, entries2);
    const store = loadHierarchy(tmpDir);
    expect(store.topics).toHaveLength(2);
  });

  it('prunes to max 50 topics by importance', () => {
    // Pre-seed with 50 low-importance topics
    const store = loadHierarchy(tmpDir);
    for (let i = 0; i < 50; i++) {
      store.topics.push({
        id: `old-topic-${i}`,
        level: 'topic',
        tags: [`unique-tag-${i}`, `filler-${i}`],
        entries: [`old-h-${i}-a`, `old-h-${i}-b`],
        summary: `Old topic ${i}`,
        importance: 0.01, // very low importance
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      });
    }
    saveHierarchy(tmpDir, store);

    // Add a new high-importance topic
    const entries = [
      makeEntry({
        contentHash: 'new1',
        conceptTags: ['brand-new-tag', 'important'],
        avgScore: 0.99,
      }),
      makeEntry({
        contentHash: 'new2',
        conceptTags: ['brand-new-tag', 'important'],
        avgScore: 0.99,
      }),
    ];
    buildTopics(tmpDir, entries);

    const updated = loadHierarchy(tmpDir);
    expect(updated.topics.length).toBeLessThanOrEqual(50);
    // The new high-importance topic should be present
    const hasNew = updated.topics.some((t) => t.tags.includes('brand-new-tag'));
    expect(hasNew).toBe(true);
    // Topics are sorted by importance descending
    for (let i = 1; i < updated.topics.length; i++) {
      expect(updated.topics[i - 1].importance).toBeGreaterThanOrEqual(
        updated.topics[i].importance,
      );
    }
  });

  it('returns empty array for entries that do not form clusters of 2+', () => {
    const entries = [
      makeEntry({ contentHash: 'h1', conceptTags: ['unique-a'] }),
    ];
    const topics = buildTopics(tmpDir, entries);
    expect(topics).toHaveLength(0);
  });
});

// ─── buildGlobals ───────────────────────────────────────────

describe('buildGlobals', () => {
  it('returns empty when fewer than 3 topics exist', () => {
    // Pre-seed with 2 topics
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 'topic-1',
        level: 'topic',
        tags: ['alpha', 'beta'],
        entries: ['h1', 'h2'],
        summary: 'Topic 1',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'topic-2',
        level: 'topic',
        tags: ['gamma', 'delta'],
        entries: ['h3', 'h4'],
        summary: 'Topic 2',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const globals = buildGlobals(tmpDir);
    expect(globals).toHaveLength(0);
  });

  it('returns empty when no topics exist at all', () => {
    const globals = buildGlobals(tmpDir);
    expect(globals).toHaveLength(0);
  });

  it('creates global patterns from topics with overlapping tags', () => {
    // Create 4 topics: two pairs with overlapping tags
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 'topic-a1',
        level: 'topic',
        tags: ['react', 'frontend', 'ui'],
        entries: ['h1'],
        summary: 'React UI',
        importance: 0.8,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'topic-a2',
        level: 'topic',
        tags: ['react', 'frontend', 'components'],
        entries: ['h2'],
        summary: 'React components',
        importance: 0.7,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'topic-b1',
        level: 'topic',
        tags: ['backend', 'database', 'sql'],
        entries: ['h3'],
        summary: 'Database queries',
        importance: 0.6,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'topic-b2',
        level: 'topic',
        tags: ['backend', 'database', 'migration'],
        entries: ['h4'],
        summary: 'DB migrations',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    // buildGlobals clusters topics with threshold=0.3
    const globals = buildGlobals(tmpDir);

    // Should produce at least one global pattern (topics with tag overlap > 0.3)
    expect(globals.length).toBeGreaterThanOrEqual(1);
    for (const g of globals) {
      expect(g.level).toBe('global');
      expect(g.id).toMatch(/^global-/);
      expect(g.summary).toContain('Global pattern');
    }

    // Verify persisted to hierarchy store
    const updated = loadHierarchy(tmpDir);
    expect(updated.globals.length).toBe(globals.length);
  });

  it('global summary includes top tags and topic count', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 't1',
        level: 'topic',
        tags: ['shared', 'common', 'alpha'],
        entries: ['h1'],
        summary: 'T1',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't2',
        level: 'topic',
        tags: ['shared', 'common', 'beta'],
        entries: ['h2'],
        summary: 'T2',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't3',
        level: 'topic',
        tags: ['shared', 'common', 'gamma'],
        entries: ['h3'],
        summary: 'T3',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const globals = buildGlobals(tmpDir);
    if (globals.length > 0) {
      expect(globals[0].summary).toContain('Global pattern');
      expect(globals[0].summary).toMatch(/\d+ topics/);
    }
  });

  it('persisted globals are limited to 20 even if more are produced', () => {
    // Seed with many topics that will form many clusters
    const store = loadHierarchy(tmpDir);
    for (let i = 0; i < 60; i++) {
      const group = i % 25; // many groups to potentially form > 20 globals
      store.topics.push({
        id: `t-${i}`,
        level: 'topic',
        tags: [`group${group}`, `shared${group}`, `extra${i}`],
        entries: [`h-${i}`],
        summary: `Topic ${i}`,
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    saveHierarchy(tmpDir, store);

    buildGlobals(tmpDir);

    // The store on disk should have at most 20 globals
    const updated = loadHierarchy(tmpDir);
    expect(updated.globals.length).toBeLessThanOrEqual(20);
  });
});

// ─── retrieveAtLevel ────────────────────────────────────────

describe('retrieveAtLevel', () => {
  it('returns matching topics by tag similarity', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 'topic-1',
        level: 'topic',
        tags: ['react', 'hooks', 'state'],
        entries: ['h1'],
        summary: 'React hooks for state management',
        importance: 0.8,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'topic-2',
        level: 'topic',
        tags: ['database', 'postgres', 'sql'],
        entries: ['h2'],
        summary: 'PostgreSQL queries',
        importance: 0.7,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, ['react', 'hooks']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].level).toBe('topic');
    expect(results[0].content).toContain('React hooks');
  });

  it('returns matching globals with 0.8 penalty applied', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 'topic-1',
        level: 'topic',
        tags: ['api', 'rest'],
        entries: ['h1'],
        summary: 'REST APIs',
        importance: 1.0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    store.globals = [
      {
        id: 'global-1',
        level: 'global',
        tags: ['api', 'rest'],
        entries: ['topic-1'],
        summary: 'Global API pattern',
        importance: 1.0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, ['api', 'rest']);
    // Both should match: topic and global
    expect(results.length).toBe(2);

    const topicResult = results.find((r) => r.level === 'topic')!;
    const globalResult = results.find((r) => r.level === 'global')!;
    expect(topicResult).toBeDefined();
    expect(globalResult).toBeDefined();
    // Global gets 0.8 penalty, so global.score < topic.score when importance is equal
    expect(globalResult.score).toBeLessThan(topicResult.score);
  });

  it('results are sorted by score descending', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 't-low',
        level: 'topic',
        tags: ['shared', 'common'],
        entries: ['h1'],
        summary: 'Low importance',
        importance: 0.3,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't-high',
        level: 'topic',
        tags: ['shared', 'common'],
        entries: ['h2'],
        summary: 'High importance',
        importance: 0.9,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, ['shared', 'common']);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].content).toContain('High importance');
  });

  it('returns empty for no tag matches', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 't-1',
        level: 'topic',
        tags: ['alpha', 'beta'],
        entries: ['h1'],
        summary: 'Alpha topic',
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, ['completely', 'different']);
    expect(results).toHaveLength(0);
  });

  it('returns empty when no hierarchy exists', () => {
    const results = retrieveAtLevel(tmpDir, ['anything']);
    expect(results).toHaveLength(0);
  });

  it('respects maxResults parameter', () => {
    const store = loadHierarchy(tmpDir);
    const sharedTags = ['shared', 'common'];
    for (let i = 0; i < 10; i++) {
      store.topics.push({
        id: `t-${i}`,
        level: 'topic',
        tags: [...sharedTags, `extra-${i}`],
        entries: [`h-${i}`],
        summary: `Topic ${i}`,
        importance: 0.5 + i * 0.01,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, sharedTags, 3);
    expect(results).toHaveLength(3);
    // Verify they are the top 3 by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('uses default maxResults of 5', () => {
    const store = loadHierarchy(tmpDir);
    const sharedTags = ['shared', 'common'];
    for (let i = 0; i < 10; i++) {
      store.topics.push({
        id: `t-${i}`,
        level: 'topic',
        tags: [...sharedTags, `extra-${i}`],
        entries: [`h-${i}`],
        summary: `Topic ${i}`,
        importance: 0.5,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    saveHierarchy(tmpDir, store);

    const results = retrieveAtLevel(tmpDir, sharedTags);
    expect(results).toHaveLength(5);
  });

  it('does not return topics with similarity below 0.2 threshold', () => {
    const store = loadHierarchy(tmpDir);
    store.topics = [
      {
        id: 't-1',
        level: 'topic',
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
        entries: ['h1'],
        summary: 'Lots of tags',
        importance: 1.0,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    saveHierarchy(tmpDir, store);

    // Only 1 matching tag out of 11 total → Jaccard: 1/11 ~ 0.09 < 0.2
    const results = retrieveAtLevel(tmpDir, ['a', 'z']);
    // Jaccard: intersection={a}=1, union={a,b,c,d,e,f,g,h,i,j,z}=11 → 1/11 ~ 0.09
    expect(results).toHaveLength(0);
  });
});
