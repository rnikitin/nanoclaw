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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR || `/workspace/group`;

// ─── Recall Tracking (lightweight inline version for container) ──────

interface RecallEntry {
  contentHash: string;
  source: string;
  recallCount: number;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  avgScore: number;
  firstSeen: string;
  lastRecalled: string;
  snippet: string;
}

function hashStr(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function trackRecallInContainer(
  query: string,
  results: Array<{ source: string; content: string; score: number }>,
): void {
  const dreamsDir = join(GROUP_DIR, '.dreams');
  const storePath = join(dreamsDir, 'short-term-recall.json');

  try {
    if (!existsSync(dreamsDir)) mkdirSync(dreamsDir, { recursive: true });

    let store: { version: number; entries: Record<string, RecallEntry>; lastUpdated: string };
    try {
      store = existsSync(storePath)
        ? JSON.parse(readFileSync(storePath, 'utf-8'))
        : { version: 1, entries: {}, lastUpdated: new Date().toISOString() };
    } catch {
      store = { version: 1, entries: {}, lastUpdated: new Date().toISOString() };
    }

    const queryHash = hashStr(query);
    const day = new Date().toISOString().slice(0, 10);

    for (const r of results) {
      const ch = hashStr(r.content);
      if (!store.entries[ch]) {
        store.entries[ch] = {
          contentHash: ch,
          source: r.source,
          recallCount: 0,
          queryHashes: [],
          recallDays: [],
          conceptTags: [],
          avgScore: 0,
          firstSeen: new Date().toISOString(),
          lastRecalled: new Date().toISOString(),
          snippet: r.content.slice(0, 280),
        };
      }
      const e = store.entries[ch];
      e.recallCount++;
      e.lastRecalled = new Date().toISOString();
      e.avgScore = ((e.avgScore * (e.recallCount - 1)) + r.score) / e.recallCount;
      if (!e.queryHashes.includes(queryHash)) {
        e.queryHashes.push(queryHash);
        if (e.queryHashes.length > 32) e.queryHashes.shift();
      }
      if (!e.recallDays.includes(day)) {
        e.recallDays.push(day);
        if (e.recallDays.length > 16) e.recallDays.shift();
      }
    }

    store.lastUpdated = new Date().toISOString();
    writeFileSync(storePath, JSON.stringify(store, null, 2));
  } catch {
    // Silently fail — don't break search over tracking issues
  }
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
      trackRecallInContainer(query, parsed);
    }

    return {
      content: [{ type: 'text', text: output || 'No results found.' }],
    };
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
