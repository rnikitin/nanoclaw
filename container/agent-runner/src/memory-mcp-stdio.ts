#!/usr/bin/env node
/**
 * Memory MCP Server — provides memory_search and memory_get tools to container agents.
 *
 * Runs as stdio MCP server alongside the main nanoclaw MCP server.
 * Uses QMD for search and integrates with recall tracking.
 *
 * Tools:
 * - memory_search: Semantic search across group memory + conversations
 * - memory_status: Check memory system health
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

import { trackContainerRecall } from './recall-tracker.js';

const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || `/workspace/group`;

// ─── QMD Availability ───────────────────────────────────────

let qmdAvailable: boolean | null = null;

function checkQmdAvailable(): boolean {
  if (qmdAvailable !== null) return qmdAvailable;
  try {
    execSync('which qmd', { stdio: 'pipe', timeout: 3000 });
    qmdAvailable = true;
  } catch {
    qmdAvailable = false;
  }
  return qmdAvailable;
}

// ─── QMD Search ──────────────────────────────────────────────

function qmdSearch(
  query: string,
  mode: 'search' | 'vsearch' | 'query' = 'search',
  limit = 6,
  collection?: string,
): string {
  const escaped = query.replace(/'/g, "'\\''");
  let cmd = `qmd ${mode} '${escaped}' --limit ${limit}`;
  if (collection) cmd += ` --collection ${collection}`;

  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    return `Error: ${err.message || 'QMD search failed'}`;
  }
}

function parseQmdResults(output: string): Array<{ source: string; content: string; score: number }> {
  const results: Array<{ source: string; content: string; score: number }> = [];
  const blocks = output.split(/\n(?=qmd:\/\/)/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const sourceMatch = block.match(/^qmd:\/\/([^\s:]+)/);
    const scoreMatch = block.match(/Score:\s*(\d+)%/);
    const contentLines = block.split('\n').filter(l =>
      !l.startsWith('qmd://') && !l.startsWith('Title:') &&
      !l.startsWith('Score:') && !l.startsWith('@@') && l.trim()
    );
    if (sourceMatch) {
      results.push({
        source: sourceMatch[1],
        content: contentLines.join('\n').trim(),
        score: scoreMatch ? parseInt(scoreMatch[1]) / 100 : 0,
      });
    }
  }
  return results;
}

// ─── Knowledge Graph ────────────────────────────────────────

// Process-wide cached handle. A single MCP server instance is bound to a
// fixed GROUP_DIR, so the knowledge-graph DB only needs to be opened once
// and reused across tool calls.
let graphDb: Database.Database | null = null;
let graphDbMissing = false;
let graphExitHandlerRegistered = false;

function getGraphDb(): Database.Database | null {
  if (graphDb) return graphDb;
  if (graphDbMissing) return null;

  const dbPath = join(GROUP_DIR, '.dreams', 'knowledge-graph.db');
  if (!existsSync(dbPath)) {
    graphDbMissing = true;
    return null;
  }
  try {
    graphDb = new Database(dbPath, { readonly: true });
    graphDb.pragma('journal_mode = WAL');
    if (!graphExitHandlerRegistered) {
      process.on('exit', () => {
        try {
          graphDb?.close();
        } catch {
          /* ignore */
        }
      });
      graphExitHandlerRegistered = true;
    }
    return graphDb;
  } catch {
    return null;
  }
}

interface GraphEntity {
  name: string;
  type: string;
  mention_count: number;
}

/**
 * Extract entity names from search results (wikilinks + source filenames).
 */
function extractEntitiesFromResults(
  results: Array<{ source: string; content: string; score: number }>,
): string[] {
  const candidates = new Set<string>();
  for (const r of results) {
    const wikiRe = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = wikiRe.exec(r.content)) !== null) {
      const name = m[1].includes('/') ? m[1].split('/').pop()! : m[1];
      candidates.add(name);
    }
    const srcName = r.source.replace(/\.md$/, '').split('/').pop();
    if (srcName && srcName.length > 2) candidates.add(srcName);
  }
  return [...candidates];
}

/**
 * Spreading activation: spread from seed entities through graph.
 * Returns related entities sorted by activation strength.
 */
function spreadActivation(
  seeds: string[],
  maxHops = 2,
  decayFactor = 0.7,
  minActivation = 0.1,
  limit = 8,
): GraphEntity[] {
  if (seeds.length === 0) return [];
  const db = getGraphDb();
  if (!db) return [];

  try {
    const activations = new Map<string, { activation: number; hops: number }>();

    for (const seed of seeds) {
      activations.set(seed.toLowerCase(), { activation: 1.0, hops: 0 });
    }

    let frontier = seeds.map(s => s.toLowerCase());

    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier: string[] = [];
      const currentDecay = Math.pow(decayFactor, hop);

      for (const current of frontier) {
        const neighbors = db.prepare(`
          SELECT to_entity as neighbor FROM relations WHERE LOWER(from_entity) = ?
          UNION
          SELECT from_entity as neighbor FROM relations WHERE LOWER(to_entity) = ?
        `).all(current, current) as Array<{ neighbor: string }>;

        for (const { neighbor } of neighbors) {
          const key = neighbor.toLowerCase();
          const existing = activations.get(key);
          if (!existing || existing.activation < currentDecay) {
            activations.set(key, { activation: currentDecay, hops: hop });
            if (currentDecay >= minActivation) nextFrontier.push(key);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    // Get entity details for activated nodes (exclude seeds)
    const seedSet = new Set(seeds.map(s => s.toLowerCase()));
    const activated = [...activations.entries()]
      .filter(([entity, { activation }]) => !seedSet.has(entity) && activation >= minActivation)
      .sort((a, b) => b[1].activation - a[1].activation)
      .slice(0, limit);

    const result: GraphEntity[] = [];
    for (const [entity] of activated) {
      const row = db.prepare(
        'SELECT name, type, mention_count FROM entities WHERE LOWER(name) = ?'
      ).get(entity) as GraphEntity | undefined;
      if (row) result.push(row);
    }

    return result;
  } catch {
    return [];
  }
}

/**
 * Query a specific entity and its relations from the knowledge graph.
 */
function queryGraphEntity(entityName: string): string {
  const db = getGraphDb();
  if (!db) return 'Knowledge graph not available (no graph database found).';

  try {
    const entity = db.prepare(
      'SELECT * FROM entities WHERE name = ? COLLATE NOCASE'
    ).get(entityName) as { name: string; type: string; mention_count: number; first_seen: string; last_seen: string } | undefined;

    if (!entity) {
      // Try fuzzy match
      const fuzzy = db.prepare(
        "SELECT * FROM entities WHERE name LIKE ? COLLATE NOCASE ORDER BY mention_count DESC LIMIT 5"
      ).all(`%${entityName}%`) as Array<{ name: string; type: string; mention_count: number }>;

      if (fuzzy.length === 0) return `Entity "${entityName}" not found in knowledge graph.`;
      return `Entity "${entityName}" not found. Similar: ${fuzzy.map(e => `${e.name} (${e.type}, ${e.mention_count} mentions)`).join(', ')}`;
    }

    // Get relations
    const outgoing = db.prepare(`
      SELECT r.to_entity, r.relation_type, r.source_file, r.evidence
      FROM relations r WHERE r.from_entity = ? COLLATE NOCASE
      ORDER BY r.created_at DESC LIMIT 20
    `).all(entityName) as Array<{ to_entity: string; relation_type: string; source_file: string; evidence: string }>;

    const incoming = db.prepare(`
      SELECT r.from_entity, r.relation_type, r.source_file, r.evidence
      FROM relations r WHERE r.to_entity = ? COLLATE NOCASE
      ORDER BY r.created_at DESC LIMIT 20
    `).all(entityName) as Array<{ from_entity: string; relation_type: string; source_file: string; evidence: string }>;

    const lines: string[] = [
      `Entity: ${entity.name} (${entity.type})`,
      `Mentions: ${entity.mention_count} | First seen: ${entity.first_seen?.slice(0, 10)} | Last seen: ${entity.last_seen?.slice(0, 10)}`,
    ];

    if (outgoing.length > 0 || incoming.length > 0) {
      lines.push('', 'Related entities:');
      const seen = new Set<string>();
      for (const r of [...outgoing, ...incoming]) {
        const other = 'to_entity' in r ? r.to_entity : (r as any).from_entity;
        if (seen.has(other)) continue;
        seen.add(other);
        lines.push(`  → ${other} (${r.relation_type}, from ${r.source_file})`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `Graph query error: ${err.message}`;
  }
}

/**
 * Find path between two entities in the knowledge graph.
 */
function findGraphPath(from: string, to: string, maxDepth = 3): string {
  const handle = getGraphDb();
  if (!handle) return 'Knowledge graph not available.';
  const db: Database.Database = handle;

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

      const neighbors = db.prepare(`
        SELECT to_entity as neighbor FROM relations WHERE from_entity = ? COLLATE NOCASE
        UNION
        SELECT from_entity as neighbor FROM relations WHERE to_entity = ? COLLATE NOCASE
      `).all(current, current) as Array<{ neighbor: string }>;

      for (const { neighbor } of neighbors) {
        dfs(neighbor, target, [...path, neighbor], depth + 1);
        if (paths.length >= 3) break; // Max 3 paths
      }
      visited.delete(current.toLowerCase());
    }

    dfs(from, to, [from], 0);

    if (paths.length === 0) return `No path found between "${from}" and "${to}" (max depth: ${maxDepth}).`;
    return `Paths between "${from}" and "${to}":\n` +
      paths.map((p, i) => `  ${i + 1}. ${p.join(' → ')}`).join('\n');
  } catch (err: any) {
    return `Graph path error: ${err.message}`;
  }
}

// ─── MCP Server ──────────────────────────────────────────────

const server = new Server(
  { name: 'memory', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description:
        'Search across your group memory, conversations, and knowledge base. ' +
        'Use this BEFORE answering questions about past work, decisions, people, preferences, or history. ' +
        'Returns relevant snippets with sources.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query',
          },
          mode: {
            type: 'string',
            enum: ['search', 'vsearch', 'query'],
            description: 'Search mode: "search" (fast keyword), "vsearch" (semantic), "query" (best quality, hybrid). Default: search',
          },
          limit: {
            type: 'number',
            description: 'Max results (default: 6)',
          },
          scope: {
            type: 'string',
            enum: ['memory', 'conversations', 'all'],
            description: 'Scope: "memory" (memory files only), "conversations" (past chats), "all" (both). Default: all',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_graph',
      description:
        'Query the knowledge graph to explore entity relationships. ' +
        'Use to find how concepts, people, projects, and decisions are connected. ' +
        'Supports: lookup (entity details + relations), path (find connections between two entities).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['lookup', 'path'],
            description: '"lookup" — entity and its relations. "path" — find connection between two entities.',
          },
          entity: {
            type: 'string',
            description: 'Entity name to look up (for "lookup" action)',
          },
          from: {
            type: 'string',
            description: 'Source entity (for "path" action)',
          },
          to: {
            type: 'string',
            description: 'Target entity (for "path" action)',
          },
        },
        required: ['action'],
      },
    },
    {
      name: 'memory_status',
      description: 'Check memory system health and indexing status.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'memory_search') {
    if (!checkQmdAvailable()) {
      return {
        content: [{
          type: 'text',
          text: 'Memory search unavailable: qmd is not installed. Memory files can still be read directly from /workspace/group/memory/. Ask the admin to install qmd for semantic search.',
        }],
      };
    }

    const query = (args as any).query as string;
    const mode = ((args as any).mode || 'search') as 'search' | 'vsearch' | 'query';
    const limit = (args as any).limit || 6;
    const scope = (args as any).scope || 'all';

    // Determine collection filter based on scope
    let collection: string | undefined;
    if (scope === 'memory') {
      collection = `${GROUP_FOLDER}-memory`;
    } else if (scope === 'conversations') {
      collection = `${GROUP_FOLDER}-conversations`;
    }
    // 'all' = no filter, searches all collections

    const output = qmdSearch(query, mode, limit, collection);

    // Track recall for dreaming
    const parsed = parseQmdResults(output);
    if (parsed.length > 0) {
      trackContainerRecall(GROUP_DIR, query, parsed);
    }

    // Augment with knowledge graph — spreading activation from matched entities
    let graphContext = '';
    if (parsed.length > 0) {
      try {
        const seeds = extractEntitiesFromResults(parsed);
        const related = spreadActivation(seeds, 2, 0.7, 0.1, 5);
        if (related.length > 0) {
          graphContext = '\n\n--- Related entities (knowledge graph) ---\n' +
            related.map(e => `• ${e.name} (${e.type}, ${e.mention_count} mentions)`).join('\n');
        }
      } catch { /* non-fatal */ }
    }

    return {
      content: [{ type: 'text', text: (output || 'No results found.') + graphContext }],
    };
  }

  if (name === 'memory_graph') {
    const action = (args as any).action as string;

    if (action === 'lookup') {
      const entity = (args as any).entity as string;
      if (!entity) {
        return { content: [{ type: 'text', text: 'Missing "entity" parameter for lookup.' }] };
      }
      const result = queryGraphEntity(entity);
      return { content: [{ type: 'text', text: result }] };
    }

    if (action === 'path') {
      const from = (args as any).from as string;
      const to = (args as any).to as string;
      if (!from || !to) {
        return { content: [{ type: 'text', text: 'Missing "from" and/or "to" parameters for path query.' }] };
      }
      const result = findGraphPath(from, to);
      return { content: [{ type: 'text', text: result }] };
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}. Use "lookup" or "path".` }] };
  }

  if (name === 'memory_status') {
    try {
      const status = execSync('qmd status', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return { content: [{ type: 'text', text: status }] };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Memory system unavailable: ${err.message}` }],
      };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// Start
const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('Memory MCP server failed:', err);
  process.exit(1);
});
