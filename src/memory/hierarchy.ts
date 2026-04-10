/**
 * Hierarchical Memory — RAPTOR-inspired multi-level abstraction.
 *
 * Three levels:
 * - Detail: individual memory entries (existing recall store)
 * - Topic: clustered summaries of related details
 * - Global: cross-topic patterns and meta-insights
 *
 * During REM sleep, details are clustered by concept tag overlap,
 * and topic-level summaries are generated. During deep sleep,
 * topic summaries feed into global-level pattern extraction.
 *
 * Retrieval adapts granularity to query specificity:
 * - Specific query → detail level
 * - Broad query → topic/global level
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

import { logger } from '../logger.js';
import type { RecallEntry } from './recall-tracker.js';

// ─── Types ───────────────────────────────────────────────────

export type MemoryLevel = 'detail' | 'topic' | 'global';

export interface TopicCluster {
  id: string;
  level: MemoryLevel;
  tags: string[];
  entries: string[]; // contentHashes of member entries
  summary: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

export interface HierarchyStore {
  version: number;
  topics: TopicCluster[];
  globals: TopicCluster[];
  lastUpdated: string;
}

// ─── Storage ─────────────────────────────────────────────────

function getStorePath(groupDir: string): string {
  return join(groupDir, '.dreams', 'hierarchy.json');
}

export function loadHierarchy(groupDir: string): HierarchyStore {
  const path = getStorePath(groupDir);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    /* corrupted */
  }
  return {
    version: 1,
    topics: [],
    globals: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function saveHierarchy(groupDir: string, store: HierarchyStore): void {
  const dreamsDir = join(groupDir, '.dreams');
  if (!existsSync(dreamsDir))
    mkdirSync(dreamsDir, { recursive: true, mode: 0o777 });
  store.lastUpdated = new Date().toISOString();
  const path = getStorePath(groupDir);
  writeFileSync(path, JSON.stringify(store, null, 2));
}

// ─── Clustering ──────────────────────────────────────────────

/** Compute Jaccard similarity between two tag sets. */
function tagSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Cluster entries by concept tag similarity.
 * Simple agglomerative approach — O(n^2) but fine for <100 entries.
 */
export function clusterEntries(
  entries: RecallEntry[],
  similarityThreshold = 0.4,
): Array<{ tags: string[]; members: RecallEntry[] }> {
  if (entries.length === 0) return [];

  // Each entry starts as its own cluster
  const clusters: Array<{ tags: string[]; members: RecallEntry[] }> =
    entries.map((e) => ({
      tags: [...e.conceptTags],
      members: [e],
    }));

  // Greedy merge: find most similar pair, merge if above threshold
  let merged = true;
  while (merged) {
    merged = false;
    let bestI = -1;
    let bestJ = -1;
    let bestSim = 0;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = tagSimilarity(clusters[i].tags, clusters[j].tags);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim >= similarityThreshold && bestI >= 0 && bestJ >= 0) {
      // Merge j into i
      clusters[bestI].members.push(...clusters[bestJ].members);
      // Union tags
      const tagSet = new Set([
        ...clusters[bestI].tags,
        ...clusters[bestJ].tags,
      ]);
      clusters[bestI].tags = [...tagSet];
      clusters.splice(bestJ, 1);
      merged = true;
    }
  }

  return clusters.filter((c) => c.members.length > 0);
}

/**
 * Generate a topic summary from cluster members.
 * Without LLM, uses tag-based summarization.
 */
function generateTopicSummary(cluster: {
  tags: string[];
  members: RecallEntry[];
}): string {
  const topTags = cluster.tags.slice(0, 5).join(', ');
  const snippets = cluster.members
    .sort((a, b) => b.avgScore - a.avgScore)
    .slice(0, 3)
    .map((m) => m.snippet.slice(0, 100));
  return `[${topTags}] ${snippets.join(' | ')}`;
}

// ─── Hierarchy Building ──────────────────────────────────────

/**
 * Build topic-level clusters from recent recall entries.
 * Called during REM sleep.
 */
export function buildTopics(
  groupDir: string,
  entries: RecallEntry[],
): TopicCluster[] {
  const now = new Date().toISOString();
  const clusters = clusterEntries(entries);

  // Only keep clusters with 2+ members (singletons stay at detail level)
  const topics: TopicCluster[] = clusters
    .filter((c) => c.members.length >= 2)
    .map((c, i) => ({
      id: `topic-${now.slice(0, 10)}-${i}`,
      level: 'topic' as MemoryLevel,
      tags: c.tags,
      entries: c.members.map((m) => m.contentHash),
      summary: generateTopicSummary(c),
      importance:
        c.members.reduce((sum, m) => sum + m.avgScore, 0) / c.members.length,
      created_at: now,
      updated_at: now,
    }));

  // Save to hierarchy store
  const store = loadHierarchy(groupDir);

  // Merge new topics with existing (deduplicate by tag overlap)
  for (const newTopic of topics) {
    const existing = store.topics.find(
      (t) => tagSimilarity(t.tags, newTopic.tags) > 0.6,
    );
    if (existing) {
      // Update existing topic
      existing.entries = [
        ...new Set([...existing.entries, ...newTopic.entries]),
      ];
      existing.summary = newTopic.summary;
      existing.importance = newTopic.importance;
      existing.updated_at = now;
      // Merge tags
      existing.tags = [...new Set([...existing.tags, ...newTopic.tags])];
    } else {
      store.topics.push(newTopic);
    }
  }

  // Prune old topics (keep last 50)
  store.topics = store.topics
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 50);

  saveHierarchy(groupDir, store);

  logger.info(
    {
      group: basename(groupDir),
      newTopics: topics.length,
      totalTopics: store.topics.length,
    },
    'Hierarchy topics updated',
  );

  return topics;
}

/**
 * Build global-level patterns from topics.
 * Called during deep sleep.
 */
export function buildGlobals(groupDir: string): TopicCluster[] {
  const now = new Date().toISOString();
  const store = loadHierarchy(groupDir);

  if (store.topics.length < 3) return [];

  // Cluster topics by tag similarity to find global themes
  const topicEntries: RecallEntry[] = store.topics.map((t) => ({
    contentHash: t.id,
    source: 'hierarchy',
    recallCount: t.entries.length,
    queryHashes: [],
    recallDays: [],
    conceptTags: t.tags,
    avgScore: t.importance,
    firstSeen: t.created_at,
    lastRecalled: t.updated_at,
    snippet: t.summary,
  }));

  const clusters = clusterEntries(topicEntries, 0.3);
  const globals: TopicCluster[] = clusters
    .filter((c) => c.members.length >= 2)
    .map((c, i) => ({
      id: `global-${now.slice(0, 10)}-${i}`,
      level: 'global' as MemoryLevel,
      tags: c.tags,
      entries: c.members.map((m) => m.contentHash),
      summary: `Global pattern: ${c.tags.slice(0, 5).join(', ')} (${c.members.length} topics)`,
      importance:
        c.members.reduce((sum, m) => sum + m.avgScore, 0) / c.members.length,
      created_at: now,
      updated_at: now,
    }));

  store.globals = globals.slice(0, 20);
  saveHierarchy(groupDir, store);

  return globals;
}

/**
 * Retrieve memories at the appropriate level for a query.
 * Specific queries → detail level.
 * Broad queries → topic/global level.
 */
export function retrieveAtLevel(
  groupDir: string,
  queryTags: string[],
  maxResults = 5,
): Array<{ level: MemoryLevel; content: string; score: number }> {
  const store = loadHierarchy(groupDir);
  const results: Array<{ level: MemoryLevel; content: string; score: number }> =
    [];

  // Score topics and globals by tag overlap
  for (const topic of store.topics) {
    const sim = tagSimilarity(queryTags, topic.tags);
    if (sim > 0.2) {
      results.push({
        level: 'topic',
        content: topic.summary,
        score: sim * topic.importance,
      });
    }
  }

  for (const global of store.globals) {
    const sim = tagSimilarity(queryTags, global.tags);
    if (sim > 0.1) {
      results.push({
        level: 'global',
        content: global.summary,
        score: sim * global.importance * 0.8, // Slight penalty for abstraction
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}
