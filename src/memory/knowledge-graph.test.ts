import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildGraph,
  queryEntity,
  listEntities,
  findPath,
  getGraphStats,
} from './knowledge-graph.js';

// ─── Helpers ────────────────────────────────────────────────

function setupGroupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nanoclaw-kg-test-'));
  mkdirSync(join(dir, '.dreams'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  return dir;
}

function writeMd(groupDir: string, relPath: string, content: string): void {
  const fullPath = join(groupDir, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

// ─── buildGraph ─────────────────────────────────────────────

describe('knowledge-graph', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = setupGroupDir();
  });

  afterEach(() => {
    rmSync(groupDir, { recursive: true, force: true });
  });

  describe('buildGraph', () => {
    it('returns zero counts for empty directory', () => {
      const stats = buildGraph(groupDir);

      expect(stats.entities).toBe(0);
      expect(stats.relations).toBe(0);
    });

    it('returns zero counts when no .md files exist', () => {
      writeFileSync(join(groupDir, 'memory', 'notes.txt'), '[[Alice]] and [[Bob]]');

      const stats = buildGraph(groupDir);

      expect(stats.entities).toBe(0);
      expect(stats.relations).toBe(0);
    });

    it('extracts typed wikilinks like [[people/Alice]]', () => {
      writeMd(groupDir, 'memory/team.md', 'Our team includes [[people/Alice]] and [[people/Bob]].');

      buildGraph(groupDir);

      const alice = queryEntity(groupDir, 'Alice');
      expect(alice).not.toBeNull();
      expect(alice!.entity.type).toBe('person');
      expect(alice!.entity.name).toBe('Alice');

      const bob = queryEntity(groupDir, 'Bob');
      expect(bob).not.toBeNull();
      expect(bob!.entity.type).toBe('person');
    });

    it('extracts project wikilinks like [[projects/Foo]]', () => {
      writeMd(groupDir, 'memory/work.md', 'Working on [[projects/Foo]] this quarter.');

      buildGraph(groupDir);

      const foo = queryEntity(groupDir, 'Foo');
      expect(foo).not.toBeNull();
      expect(foo!.entity.type).toBe('project');
    });

    it('extracts bare concept wikilinks like [[SomeConcept]]', () => {
      writeMd(groupDir, 'memory/notes.md', 'This relates to [[MachineLearning]] and [[NeuralNetworks]].');

      buildGraph(groupDir);

      const ml = queryEntity(groupDir, 'MachineLearning');
      expect(ml).not.toBeNull();
      expect(ml!.entity.type).toBe('concept');
    });

    it('extracts task IDs like *S18* and *M31*', () => {
      writeMd(groupDir, 'memory/tasks.md', 'Completed *S18* and started *M31* this sprint.');

      buildGraph(groupDir);

      const s18 = queryEntity(groupDir, 'S18');
      expect(s18).not.toBeNull();
      expect(s18!.entity.type).toBe('task');

      const m31 = queryEntity(groupDir, 'M31');
      expect(m31).not.toBeNull();
      expect(m31!.entity.type).toBe('task');
    });

    it('extracts *D* and *P* task prefixes', () => {
      writeMd(groupDir, 'memory/tasks.md', 'Decision *D5* blocks *P12* progress.');

      buildGraph(groupDir);

      const d5 = queryEntity(groupDir, 'D5');
      expect(d5).not.toBeNull();
      expect(d5!.entity.type).toBe('task');

      const p12 = queryEntity(groupDir, 'P12');
      expect(p12).not.toBeNull();
      expect(p12!.entity.type).toBe('task');
    });

    it('creates co-occurrence relations between entities in the same file', () => {
      writeMd(groupDir, 'memory/meeting.md',
        '[[people/Alice]] discussed [[projects/Alpha]] with [[people/Bob]].',
      );

      buildGraph(groupDir);

      // Alice should be connected to both Alpha and Bob
      const alice = queryEntity(groupDir, 'Alice');
      expect(alice).not.toBeNull();
      expect(alice!.relations.length).toBeGreaterThanOrEqual(2);

      const relatedNames = alice!.relations.map((r) => r.related_entity.name);
      expect(relatedNames).toContain('Alpha');
      expect(relatedNames).toContain('Bob');
    });

    it('co-occurrence relations have correct type and evidence', () => {
      writeMd(groupDir, 'memory/context.md',
        '[[people/Alice]] works on [[projects/Beta]].',
      );

      buildGraph(groupDir);

      const alice = queryEntity(groupDir, 'Alice');
      expect(alice).not.toBeNull();

      const betaRel = alice!.relations.find((r) => r.related_entity.name === 'Beta');
      expect(betaRel).toBeDefined();
      expect(betaRel!.relation_type).toBe('co_occurrence');
      expect(betaRel!.evidence).toContain('Co-mentioned in');
    });

    it('handles entities across multiple files', () => {
      writeMd(groupDir, 'memory/file1.md', '[[people/Alice]] likes [[Rust]].');
      writeMd(groupDir, 'memory/file2.md', '[[people/Alice]] uses [[Python]].');

      buildGraph(groupDir);

      const alice = queryEntity(groupDir, 'Alice');
      expect(alice).not.toBeNull();
      // Alice appears in 2 files, mention_count should reflect both
      expect(alice!.entity.mention_count).toBeGreaterThanOrEqual(2);

      const relatedNames = alice!.relations.map((r) => r.related_entity.name);
      expect(relatedNames).toContain('Rust');
      expect(relatedNames).toContain('Python');
    });

    it('scans memory/ directory', () => {
      writeMd(groupDir, 'memory/insight.md', '[[people/Charlie]] discovered [[Gravity]].');

      buildGraph(groupDir);

      const charlie = queryEntity(groupDir, 'Charlie');
      expect(charlie).not.toBeNull();
    });

    it('scans conversations/ directory', () => {
      mkdirSync(join(groupDir, 'conversations'), { recursive: true });
      writeMd(groupDir, 'conversations/chat.md', '[[people/Dave]] mentioned [[Kubernetes]].');

      buildGraph(groupDir);

      const dave = queryEntity(groupDir, 'Dave');
      expect(dave).not.toBeNull();
    });

    it('scans tasks/ directory', () => {
      mkdirSync(join(groupDir, 'tasks'), { recursive: true });
      writeMd(groupDir, 'tasks/sprint.md', 'Assigned *S42* to [[people/Eve]].');

      buildGraph(groupDir);

      const eve = queryEntity(groupDir, 'Eve');
      expect(eve).not.toBeNull();
      const s42 = queryEntity(groupDir, 'S42');
      expect(s42).not.toBeNull();
    });

    it('scans research/ directory', () => {
      mkdirSync(join(groupDir, 'research'), { recursive: true });
      writeMd(groupDir, 'research/paper.md', '[[QuantumComputing]] is advancing rapidly.');

      buildGraph(groupDir);

      const qc = queryEntity(groupDir, 'QuantumComputing');
      expect(qc).not.toBeNull();
    });

    it('handles nested directories like memory/projects/foo.md', () => {
      writeMd(groupDir, 'memory/projects/alpha.md',
        '[[people/Frank]] leads [[projects/Alpha]].',
      );

      buildGraph(groupDir);

      const frank = queryEntity(groupDir, 'Frank');
      expect(frank).not.toBeNull();

      const alpha = queryEntity(groupDir, 'Alpha');
      expect(alpha).not.toBeNull();
    });

    it('creates the SQLite DB at .dreams/knowledge-graph.db', () => {
      writeMd(groupDir, 'memory/test.md', '[[TestEntity]]');

      buildGraph(groupDir);

      const dbPath = join(groupDir, '.dreams', 'knowledge-graph.db');
      expect(existsSync(dbPath)).toBe(true);
    });

    it('is idempotent — rebuilding increases mention_count', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Grace]] works on [[projects/Gamma]].');

      buildGraph(groupDir);
      const firstBuild = queryEntity(groupDir, 'Grace');
      const firstCount = firstBuild!.entity.mention_count;

      buildGraph(groupDir);
      const secondBuild = queryEntity(groupDir, 'Grace');
      const secondCount = secondBuild!.entity.mention_count;

      expect(secondCount).toBeGreaterThan(firstCount);
    });

    it('handles mixed wikilinks and task IDs in the same file', () => {
      writeMd(groupDir, 'memory/mixed.md',
        '[[people/Hank]] completed *M7* for [[projects/Delta]] while researching [[AI]].',
      );

      buildGraph(groupDir);

      const entities = listEntities(groupDir);
      const names = entities.map((e) => e.name);
      expect(names).toContain('Hank');
      expect(names).toContain('M7');
      expect(names).toContain('Delta');
      expect(names).toContain('AI');
    });

    it('handles decision wikilinks [[decisions/Foo]]', () => {
      writeMd(groupDir, 'memory/decisions.md', 'We made [[decisions/UseRust]] last quarter.');

      buildGraph(groupDir);

      const decision = queryEntity(groupDir, 'UseRust');
      expect(decision).not.toBeNull();
      expect(decision!.entity.type).toBe('decision');
    });

    it('handles task/ prefixed wikilinks [[task/Setup]]', () => {
      writeMd(groupDir, 'memory/plan.md', 'Next step is [[task/Setup]] the infra.');

      buildGraph(groupDir);

      const setup = queryEntity(groupDir, 'Setup');
      expect(setup).not.toBeNull();
      expect(setup!.entity.type).toBe('task');
    });
  });

  // ─── queryEntity ──────────────────────────────────────────

  describe('queryEntity', () => {
    it('returns entity and relations for existing entity', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]] and [[projects/Omega]].');
      buildGraph(groupDir);

      const result = queryEntity(groupDir, 'Alice');

      expect(result).not.toBeNull();
      expect(result!.entity.name).toBe('Alice');
      expect(result!.entity.type).toBe('person');
      expect(result!.relations).toBeInstanceOf(Array);
      expect(result!.relations.length).toBeGreaterThanOrEqual(1);
    });

    it('returns null for non-existing entity', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]].');
      buildGraph(groupDir);

      const result = queryEntity(groupDir, 'NonExistent');

      expect(result).toBeNull();
    });

    it('is case-insensitive', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]].');
      buildGraph(groupDir);

      const lower = queryEntity(groupDir, 'alice');
      const upper = queryEntity(groupDir, 'ALICE');
      const mixed = queryEntity(groupDir, 'aLiCe');

      expect(lower).not.toBeNull();
      expect(upper).not.toBeNull();
      expect(mixed).not.toBeNull();
      expect(lower!.entity.name).toBe('Alice');
      expect(upper!.entity.name).toBe('Alice');
    });

    it('returns relations with correct direction labels', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]] and [[people/Bob]] and [[projects/Zeta]].');
      buildGraph(groupDir);

      const alice = queryEntity(groupDir, 'Alice');
      expect(alice).not.toBeNull();

      // Relations are alphabetically ordered so Alice might be from_entity or to_entity
      for (const rel of alice!.relations) {
        expect(['outgoing', 'incoming']).toContain(rel.direction);
        expect(rel.related_entity.name).toBeTruthy();
      }
    });

    it('returns null on empty graph', () => {
      // Build with no files
      buildGraph(groupDir);
      const result = queryEntity(groupDir, 'Anyone');
      expect(result).toBeNull();
    });
  });

  // ─── listEntities ─────────────────────────────────────────

  describe('listEntities', () => {
    it('returns all entities when no type filter', () => {
      writeMd(groupDir, 'memory/test.md',
        '[[people/Alice]] works on [[projects/Beta]] using [[Docker]].',
      );
      buildGraph(groupDir);

      const all = listEntities(groupDir);

      expect(all.length).toBe(3);
      const names = all.map((e) => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Beta');
      expect(names).toContain('Docker');
    });

    it('filters by type when specified', () => {
      writeMd(groupDir, 'memory/test.md',
        '[[people/Alice]] and [[people/Bob]] work on [[projects/Gamma]].',
      );
      buildGraph(groupDir);

      const people = listEntities(groupDir, 'person');
      expect(people).toHaveLength(2);
      expect(people.every((e) => e.type === 'person')).toBe(true);

      const projects = listEntities(groupDir, 'project');
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Gamma');
    });

    it('returns empty array for empty graph', () => {
      buildGraph(groupDir);
      const all = listEntities(groupDir);
      expect(all).toHaveLength(0);
    });

    it('returns empty array for non-matching type filter', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]].');
      buildGraph(groupDir);

      const projects = listEntities(groupDir, 'project');
      expect(projects).toHaveLength(0);
    });

    it('returns entities sorted by mention_count descending', () => {
      // Alice appears in 3 files, Bob in 1
      writeMd(groupDir, 'memory/a.md', '[[people/Alice]] note 1.');
      writeMd(groupDir, 'memory/b.md', '[[people/Alice]] note 2.');
      writeMd(groupDir, 'memory/c.md', '[[people/Alice]] and [[people/Bob]] note 3.');
      buildGraph(groupDir);

      const people = listEntities(groupDir, 'person');
      expect(people.length).toBe(2);
      expect(people[0].name).toBe('Alice');
      expect(people[0].mention_count).toBeGreaterThan(people[1].mention_count);
    });

    it('returns task entities extracted from *ID* patterns', () => {
      writeMd(groupDir, 'memory/sprint.md', 'Tasks: *S1*, *S2*, *M10*.');
      buildGraph(groupDir);

      const tasks = listEntities(groupDir, 'task');
      expect(tasks).toHaveLength(3);
      const names = tasks.map((e) => e.name);
      expect(names).toContain('S1');
      expect(names).toContain('S2');
      expect(names).toContain('M10');
    });
  });

  // ─── findPath ─────────────────────────────────────────────

  describe('findPath', () => {
    it('finds direct connection between two entities', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]] and [[people/Bob]].');
      buildGraph(groupDir);

      const paths = findPath(groupDir, 'Alice', 'Bob');

      expect(paths.length).toBeGreaterThanOrEqual(1);
      // Direct path: Alice -> Bob (2 nodes)
      const directPath = paths.find((p) => p.length === 2);
      expect(directPath).toBeDefined();
      expect(directPath![0].toLowerCase()).toBe('alice');
      expect(directPath![1].toLowerCase()).toBe('bob');
    });

    it('finds multi-hop path', () => {
      // Alice -> Concept (file1), Concept -> Bob (file2)
      writeMd(groupDir, 'memory/file1.md', '[[people/Alice]] studies [[GraphTheory]].');
      writeMd(groupDir, 'memory/file2.md', '[[people/Bob]] teaches [[GraphTheory]].');
      buildGraph(groupDir);

      const paths = findPath(groupDir, 'Alice', 'Bob');

      expect(paths.length).toBeGreaterThanOrEqual(1);
      // Should find Alice -> GraphTheory -> Bob
      const multiHop = paths.find((p) => p.length === 3);
      expect(multiHop).toBeDefined();
    });

    it('returns empty array when no path exists', () => {
      writeMd(groupDir, 'memory/file1.md', '[[people/Alice]] and [[ConceptA]].');
      writeMd(groupDir, 'memory/file2.md', '[[people/Bob]] and [[ConceptB]].');
      buildGraph(groupDir);

      const paths = findPath(groupDir, 'Alice', 'Bob');
      expect(paths).toHaveLength(0);
    });

    it('returns empty array for non-existing entities', () => {
      buildGraph(groupDir);
      const paths = findPath(groupDir, 'Ghost1', 'Ghost2');
      expect(paths).toHaveLength(0);
    });

    it('respects maxDepth parameter', () => {
      // Create a chain: A-B (file1), B-C (file2), C-D (file3)
      writeMd(groupDir, 'memory/f1.md', '[[NodeA]] and [[NodeB]].');
      writeMd(groupDir, 'memory/f2.md', '[[NodeB]] and [[NodeC]].');
      writeMd(groupDir, 'memory/f3.md', '[[NodeC]] and [[NodeD]].');
      buildGraph(groupDir);

      // maxDepth=1 should not find A->D (needs 3 hops)
      const shallow = findPath(groupDir, 'NodeA', 'NodeD', 1);
      expect(shallow).toHaveLength(0);

      // maxDepth=3 should find the path
      const deep = findPath(groupDir, 'NodeA', 'NodeD', 3);
      expect(deep.length).toBeGreaterThanOrEqual(1);
    });

    it('handles cycles safely without infinite loop', () => {
      // A-B and B-C and C-A form a cycle
      writeMd(groupDir, 'memory/f1.md', '[[CycleA]] and [[CycleB]].');
      writeMd(groupDir, 'memory/f2.md', '[[CycleB]] and [[CycleC]].');
      writeMd(groupDir, 'memory/f3.md', '[[CycleC]] and [[CycleA]].');
      buildGraph(groupDir);

      // Should not hang — DFS uses visited set
      const paths = findPath(groupDir, 'CycleA', 'CycleC');
      expect(paths.length).toBeGreaterThanOrEqual(1);
    });

    it('finds path from entity to itself (trivial)', () => {
      writeMd(groupDir, 'memory/test.md', '[[people/Alice]] and [[ConceptX]].');
      buildGraph(groupDir);

      const paths = findPath(groupDir, 'Alice', 'Alice');
      // Should find the trivial path [Alice]
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths[0]).toEqual(['Alice']);
    });
  });

  // ─── getGraphStats ────────────────────────────────────────

  describe('getGraphStats', () => {
    it('returns zeros for empty graph (no DB file)', () => {
      // Don't build — no DB file exists
      const stats = getGraphStats(groupDir);

      expect(stats.entities).toBe(0);
      expect(stats.relations).toBe(0);
      expect(stats.byType).toEqual({});
    });

    it('returns zeros for built but empty graph', () => {
      buildGraph(groupDir);
      const stats = getGraphStats(groupDir);

      expect(stats.entities).toBe(0);
      expect(stats.relations).toBe(0);
      expect(stats.byType).toEqual({});
    });

    it('returns correct counts for populated graph', () => {
      writeMd(groupDir, 'memory/test.md',
        '[[people/Alice]] and [[people/Bob]] work on [[projects/Omega]].',
      );
      buildGraph(groupDir);

      const stats = getGraphStats(groupDir);

      expect(stats.entities).toBe(3);
      // 3 entities in same file => 3 co-occurrence relations (A-B, A-O, B-O)
      expect(stats.relations).toBe(3);
      expect(stats.byType.person).toBe(2);
      expect(stats.byType.project).toBe(1);
    });

    it('returns correct byType breakdown', () => {
      writeMd(groupDir, 'memory/a.md', '[[people/Alice]] studies [[Topology]].');
      writeMd(groupDir, 'memory/b.md', '*S1* and *M2* are tasks. [[decisions/GoRust]].');
      buildGraph(groupDir);

      const stats = getGraphStats(groupDir);

      expect(stats.byType.person).toBe(1);
      expect(stats.byType.concept).toBe(1);
      expect(stats.byType.task).toBe(2);
      expect(stats.byType.decision).toBe(1);
    });

    it('counts unique entities not total mentions', () => {
      writeMd(groupDir, 'memory/a.md', '[[people/Alice]] note 1.');
      writeMd(groupDir, 'memory/b.md', '[[people/Alice]] note 2.');
      writeMd(groupDir, 'memory/c.md', '[[people/Alice]] note 3.');
      buildGraph(groupDir);

      const stats = getGraphStats(groupDir);

      // Alice is one entity despite 3 mentions
      expect(stats.entities).toBe(1);
      expect(stats.byType.person).toBe(1);
    });
  });
});
