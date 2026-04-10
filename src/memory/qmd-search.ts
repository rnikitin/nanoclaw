/**
 * QMD Search — wrapper around QMD CLI for memory search.
 *
 * Provides memory_search functionality using QMD's hybrid search
 * (BM25 + vector + reranking) with recall tracking integration.
 */

import { execSync } from 'child_process';
import { trackRecall } from './recall-tracker.js';

export interface SearchResult {
  source: string;
  content: string;
  score: number;
  collection: string;
  line: number;
}

export interface SearchOptions {
  /** Search mode: 'search' (BM25), 'vsearch' (vector), 'query' (hybrid) */
  mode?: 'search' | 'vsearch' | 'query';
  /** Max results to return */
  limit?: number;
  /** Filter to specific collection name */
  collection?: string;
  /** Timeout in ms */
  timeoutMs?: number;
}

const DEFAULT_OPTIONS: SearchOptions = {
  mode: 'search',
  limit: 6,
  timeoutMs: 10_000,
};

/**
 * Search memory using QMD.
 *
 * @param query - Search query
 * @param groupDir - Group directory (for recall tracking)
 * @param options - Search options
 */
export function memorySearch(
  query: string,
  groupDir: string,
  options: SearchOptions = {},
): SearchResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const cmd = buildCommand(query, opts);

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const results = parseResults(output);

    // Track recall for dreaming
    if (results.length > 0 && groupDir) {
      try {
        trackRecall(groupDir, query, results);
      } catch {
        // Don't fail search if tracking fails
      }
    }

    return results;
  } catch (err: any) {
    if (err.status === null) {
      // timeout
      return [];
    }
    // QMD not found or other error
    console.error(`QMD search error: ${err.message}`);
    return [];
  }
}

function buildCommand(query: string, opts: SearchOptions): string {
  const escaped = query.replace(/'/g, "'\\''");
  let cmd = `qmd ${opts.mode} '${escaped}' --json --limit ${opts.limit}`;

  if (opts.collection) {
    cmd += ` --collection ${opts.collection}`;
  }

  return cmd;
}

function parseResults(output: string): SearchResult[] {
  try {
    const data = JSON.parse(output);
    if (Array.isArray(data)) {
      return data.map((r: any) => ({
        source: r.path || r.source || '',
        content: r.content || r.snippet || r.text || '',
        score: r.score || r.relevance || 0,
        collection: r.collection || '',
        line: r.line || 0,
      }));
    }
    // QMD may return { results: [...] }
    if (data.results && Array.isArray(data.results)) {
      return data.results.map((r: any) => ({
        source: r.path || r.source || '',
        content: r.content || r.snippet || r.text || '',
        score: r.score || r.relevance || 0,
        collection: r.collection || '',
        line: r.line || 0,
      }));
    }
  } catch {
    // Non-JSON output, parse text format
    return parseTextResults(output);
  }
  return [];
}

function parseTextResults(output: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = output.split(/\n(?=qmd:\/\/)/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const sourceMatch = block.match(/^qmd:\/\/([^\s:]+)/);
    const scoreMatch = block.match(/Score:\s*(\d+)%/);
    const contentLines = block
      .split('\n')
      .filter(
        (l) =>
          !l.startsWith('qmd://') &&
          !l.startsWith('Title:') &&
          !l.startsWith('Score:') &&
          !l.startsWith('@@') &&
          l.trim(),
      );

    if (sourceMatch) {
      results.push({
        source: sourceMatch[1],
        content: contentLines.join('\n').trim(),
        score: scoreMatch ? parseInt(scoreMatch[1]) / 100 : 0,
        collection: '',
        line: 0,
      });
    }
  }

  return results;
}

/**
 * Get QMD status — checks if QMD is available and indexed.
 */
export function getQmdStatus(): {
  available: boolean;
  version?: string;
  collections?: number;
  indexed?: number;
} {
  try {
    const version = execSync('qmd --version', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    let collections = 0;
    let indexed = 0;
    try {
      const status = execSync('qmd status --json', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const data = JSON.parse(status);
      collections = data.collections?.length || 0;
      indexed = data.totalDocuments || data.indexed || 0;
    } catch {
      /* ignore */
    }

    return { available: true, version, collections, indexed };
  } catch {
    return { available: false };
  }
}
