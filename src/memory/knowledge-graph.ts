/**
 * Knowledge Graph — entity-relation graph built from memory files.
 *
 * Document-centric approach: [[wikilinks]] in markdown files are the
 * source of truth. This module parses them and builds a SQLite index
 * for fast graph queries. The index can be rebuilt from files at any time.
 *
 * Entity types: person, project, task, decision, concept
 * Relation types: mentions, depends_on, blocks, related_to, decided_by
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { join, relative, basename } from 'path';
import Database from 'better-sqlite3';

import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────

export interface Entity {
  id: number;
  type: string;
  name: string;
  importance: number;
  first_seen: string;
  last_seen: string;
  mention_count: number;
}

export interface Relation {
  id: number;
  from_entity: string;
  to_entity: string;
  relation_type: string;
  evidence: string;
  source_file: string;
  created_at: string;
}

export interface GraphQueryResult {
  entity: Entity;
  relations: Array<{
    related_entity: Entity;
    relation_type: string;
    direction: 'outgoing' | 'incoming';
    evidence: string;
  }>;
}

// ─── Database ────────────────────────────────────────────────

function getDbPath(groupDir: string): string {
  return join(groupDir, '.dreams', 'knowledge-graph.db');
}

function openDb(groupDir: string): Database.Database {
  const dreamsDir = join(groupDir, '.dreams');
  if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true, mode: 0o777 });

  const dbPath = getDbPath(groupDir);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL UNIQUE,
      importance REAL DEFAULT 0.5,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'mentions',
      evidence TEXT,
      source_file TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(from_entity, to_entity, relation_type, source_file)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_entity);
    CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_entity);
  `);

  return db;
}

// ─── Entity Extraction ───────────────────────────────────────

/** Extract [[wikilink]] references from markdown text. */
function extractWikilinks(text: string): Array<{ raw: string; type: string; name: string }> {
  const results: Array<{ raw: string; type: string; name: string }> = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1];
    // Parse type/name from patterns like [[people/Имя]] or [[projects/Name]]
    const parts = raw.split('/');
    if (parts.length >= 2) {
      const typeMap: Record<string, string> = {
        people: 'person', person: 'person', persons: 'person',
        projects: 'project', project: 'project',
        decisions: 'decision', decision: 'decision',
        tasks: 'task', task: 'task',
      };
      const type = typeMap[parts[0].toLowerCase()] || 'concept';
      const name = parts.slice(1).join('/');
      results.push({ raw, type, name });
    } else {
      results.push({ raw, type: 'concept', name: raw });
    }
  }
  return results;
}

/** Extract task IDs like *S18*, *M31* from text. */
function extractTaskIds(text: string): string[] {
  const re = /\*([SMDP]\d+)\*/g;
  const ids: string[] = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/** Infer entity type from name patterns. */
function inferEntityType(name: string): string {
  if (/^[SMDP]\d+$/.test(name)) return 'task';
  return 'concept';
}

// ─── Graph Building ──────────────────────────────────────────

interface ExtractedEntity {
  type: string;
  name: string;
  source: string;
  context: string;
}

/** Extract all entities from a single markdown file. */
function extractFromFile(
  filePath: string,
  groupDir: string,
): ExtractedEntity[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const relPath = relative(groupDir, filePath);
  const entities: ExtractedEntity[] = [];

  // Extract wikilinks
  for (const link of extractWikilinks(content)) {
    entities.push({
      type: link.type,
      name: link.name,
      source: relPath,
      context: '', // Will be filled with surrounding text
    });
  }

  // Extract task IDs
  for (const taskId of extractTaskIds(content)) {
    entities.push({
      type: 'task',
      name: taskId,
      source: relPath,
      context: '',
    });
  }

  return entities;
}

/** Scan all markdown files in memory/ and conversations/ directories. */
function scanGroupFiles(groupDir: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const dirs = ['memory', 'conversations', 'tasks', 'research'];

  for (const dir of dirs) {
    const dirPath = join(groupDir, dir);
    if (!existsSync(dirPath)) continue;
    scanDirRecursive(dirPath, groupDir, entities);
  }

  return entities;
}

function scanDirRecursive(
  dir: string,
  groupDir: string,
  entities: ExtractedEntity[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as string[];
  } catch {
    return;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirRecursive(fullPath, groupDir, entities);
    } else if (entry.name.endsWith('.md')) {
      entities.push(...extractFromFile(fullPath, groupDir));
    }
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Build or rebuild the knowledge graph for a group.
 * Scans all markdown files for [[wikilinks]] and task IDs,
 * then upserts entities and creates co-occurrence relations.
 */
export function buildGraph(groupDir: string): {
  entities: number;
  relations: number;
} {
  const db = openDb(groupDir);
  const now = new Date().toISOString();

  try {
    const extracted = scanGroupFiles(groupDir);

    // Group by source file for co-occurrence detection
    const byFile = new Map<string, ExtractedEntity[]>();
    for (const e of extracted) {
      if (!byFile.has(e.source)) byFile.set(e.source, []);
      byFile.get(e.source)!.push(e);
    }

    const upsertEntity = db.prepare(`
      INSERT INTO entities (type, name, importance, first_seen, last_seen, mention_count)
      VALUES (?, ?, 0.5, ?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        last_seen = ?,
        mention_count = mention_count + 1,
        type = CASE WHEN excluded.type != 'concept' THEN excluded.type ELSE entities.type END
    `);

    const upsertRelation = db.prepare(`
      INSERT OR IGNORE INTO relations (from_entity, to_entity, relation_type, evidence, source_file, created_at)
      VALUES (?, ?, 'co_occurrence', ?, ?, ?)
    `);

    let entityCount = 0;
    let relationCount = 0;

    const transaction = db.transaction(() => {
      for (const [source, fileEntities] of byFile) {
        // Upsert each entity
        for (const e of fileEntities) {
          upsertEntity.run(e.type, e.name, now, now, now);
          entityCount++;
        }

        // Create co-occurrence relations between entities in same file
        const names = [...new Set(fileEntities.map((e) => e.name))];
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            // Alphabetical ordering to avoid duplicates
            const [a, b] = [names[i], names[j]].sort();
            upsertRelation.run(a, b, `Co-mentioned in ${source}`, source, now);
            relationCount++;
          }
        }
      }
    });

    transaction();

    logger.info(
      { group: basename(groupDir), entities: entityCount, relations: relationCount },
      'Knowledge graph rebuilt',
    );

    return { entities: entityCount, relations: relationCount };
  } finally {
    db.close();
  }
}

/**
 * Query the knowledge graph for an entity and its relations.
 */
export function queryEntity(
  groupDir: string,
  entityName: string,
): GraphQueryResult | null {
  const db = openDb(groupDir);
  try {
    const entity = db
      .prepare('SELECT * FROM entities WHERE name = ? COLLATE NOCASE')
      .get(entityName) as Entity | undefined;

    if (!entity) return null;

    const outgoing = db
      .prepare(`
        SELECT r.*, e.type, e.name as entity_name, e.importance, e.mention_count
        FROM relations r
        JOIN entities e ON e.name = r.to_entity
        WHERE r.from_entity = ? COLLATE NOCASE
      `)
      .all(entityName) as Array<Relation & { type: string; entity_name: string; importance: number; mention_count: number }>;

    const incoming = db
      .prepare(`
        SELECT r.*, e.type, e.name as entity_name, e.importance, e.mention_count
        FROM relations r
        JOIN entities e ON e.name = r.from_entity
        WHERE r.to_entity = ? COLLATE NOCASE
      `)
      .all(entityName) as Array<Relation & { type: string; entity_name: string; importance: number; mention_count: number }>;

    const relations = [
      ...outgoing.map((r) => ({
        related_entity: {
          id: 0,
          type: r.type,
          name: r.entity_name,
          importance: r.importance,
          first_seen: '',
          last_seen: '',
          mention_count: r.mention_count,
        } as Entity,
        relation_type: r.relation_type,
        direction: 'outgoing' as const,
        evidence: r.evidence || '',
      })),
      ...incoming.map((r) => ({
        related_entity: {
          id: 0,
          type: r.type,
          name: r.entity_name,
          importance: r.importance,
          first_seen: '',
          last_seen: '',
          mention_count: r.mention_count,
        } as Entity,
        relation_type: r.relation_type,
        direction: 'incoming' as const,
        evidence: r.evidence || '',
      })),
    ];

    return { entity, relations };
  } finally {
    db.close();
  }
}

/**
 * Find all entities of a given type.
 */
export function listEntities(
  groupDir: string,
  type?: string,
): Entity[] {
  const db = openDb(groupDir);
  try {
    if (type) {
      return db
        .prepare('SELECT * FROM entities WHERE type = ? ORDER BY mention_count DESC')
        .all(type) as Entity[];
    }
    return db
      .prepare('SELECT * FROM entities ORDER BY mention_count DESC')
      .all() as Entity[];
  } finally {
    db.close();
  }
}

/**
 * Find path between two entities (up to maxDepth hops).
 */
export function findPath(
  groupDir: string,
  fromName: string,
  toName: string,
  maxDepth = 3,
): string[][] {
  const db = openDb(groupDir);
  try {
    const paths: string[][] = [];
    const visited = new Set<string>();

    function dfs(current: string, target: string, path: string[], depth: number): void {
      if (depth > maxDepth) return;
      if (current.toLowerCase() === target.toLowerCase()) {
        paths.push([...path]);
        return;
      }
      if (visited.has(current.toLowerCase())) return;
      visited.add(current.toLowerCase());

      const neighbors = db
        .prepare(`
          SELECT to_entity as neighbor FROM relations WHERE from_entity = ? COLLATE NOCASE
          UNION
          SELECT from_entity as neighbor FROM relations WHERE to_entity = ? COLLATE NOCASE
        `)
        .all(current, current) as Array<{ neighbor: string }>;

      for (const { neighbor } of neighbors) {
        dfs(neighbor, target, [...path, neighbor], depth + 1);
      }
      visited.delete(current.toLowerCase());
    }

    dfs(fromName, toName, [fromName], 0);
    return paths;
  } finally {
    db.close();
  }
}

/**
 * Get graph statistics for a group.
 */
export function getGraphStats(groupDir: string): {
  entities: number;
  relations: number;
  byType: Record<string, number>;
} {
  const dbPath = getDbPath(groupDir);
  if (!existsSync(dbPath)) {
    return { entities: 0, relations: 0, byType: {} };
  }
  const db = openDb(groupDir);
  try {
    const entities = (db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    const relations = (db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    const types = db
      .prepare('SELECT type, COUNT(*) as c FROM entities GROUP BY type')
      .all() as Array<{ type: string; c: number }>;
    const byType: Record<string, number> = {};
    for (const t of types) byType[t.type] = t.c;
    return { entities, relations, byType };
  } finally {
    db.close();
  }
}
