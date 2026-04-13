/**
 * Dreaming Engine — 3-phase memory consolidation.
 *
 * Runs as NanoClaw scheduled tasks:
 * - Light Sleep: every 6h — ingest daily signals, deduplicate
 * - REM Sleep: weekly — extract patterns, build themes
 * - Deep Sleep: daily 3 AM — score candidates, promote to MEMORY.md
 *
 * Each group dreams independently. Cross-group insights
 * can be promoted to global/memory/.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  appendFileSync,
} from 'fs';
import { join, basename } from 'path';
import { logger } from '../logger.js';
import { CREDENTIAL_PROXY_PORT } from '../config.js';
import { PROXY_BIND_HOST } from '../container-runtime.js';
import {
  loadRecallStore,
  saveRecallStore,
  getTopRecallCandidates,
  type RecallEntry,
} from './recall-tracker.js';
import {
  rankCandidates,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLDS,
  type ScoredCandidate,
} from './promotion-scorer.js';
import { buildGraph } from './knowledge-graph.js';
import { buildTopics, buildGlobals } from './hierarchy.js';
import { dedupRecallEntries } from './dedup.js';

// ─── Phase Signals ────────────────────────────────────────────

interface PhaseSignal {
  phase: 'light' | 'rem';
  contentHash: string;
  boost: number;
  timestamp: string;
}

interface PhaseSignalStore {
  signals: PhaseSignal[];
  lastUpdated: string;
}

function loadPhaseSignals(groupDir: string): PhaseSignalStore {
  const path = join(groupDir, '.dreams', 'phase-signals.json');
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'));
    }
  } catch {
    /* corrupted */
  }
  return { signals: [], lastUpdated: new Date().toISOString() };
}

function savePhaseSignals(groupDir: string, store: PhaseSignalStore): void {
  const dreamsDir = join(groupDir, '.dreams');
  if (!existsSync(dreamsDir))
    mkdirSync(dreamsDir, { recursive: true, mode: 0o777 });
  store.lastUpdated = new Date().toISOString();
  const path = join(dreamsDir, 'phase-signals.json');
  writeFileSync(path, JSON.stringify(store, null, 2));
  try {
    require('fs').chmodSync(path, 0o666);
  } catch {
    /* ignore */
  }
}

// ─── Daily Notes ──────────────────────────────────────────────

function getDailyNotePath(groupDir: string, date?: string): string {
  const d = date || new Date().toISOString().slice(0, 10);
  return join(groupDir, 'memory', `${d}.md`);
}

function readDailyNotes(groupDir: string, lookbackDays = 2): string[] {
  const notes: string[] = [];
  const now = new Date();
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const path = getDailyNotePath(groupDir, d.toISOString().slice(0, 10));
    try {
      if (existsSync(path)) {
        notes.push(readFileSync(path, 'utf-8'));
      }
    } catch {
      /* ignore */
    }
  }
  return notes;
}

// ─── Deduplication ────────────────────────────────────────────

function similarity(a: string, b: string): number {
  // Simple Jaccard similarity on word sets
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

function deduplicateCandidates(
  entries: RecallEntry[],
  threshold = 0.9,
): RecallEntry[] {
  const result: RecallEntry[] = [];
  for (const entry of entries) {
    const isDup = result.some(
      (e) => similarity(e.snippet, entry.snippet) >= threshold,
    );
    if (!isDup) {
      result.push(entry);
    }
  }
  return result;
}

// ─── Phase 1: Light Sleep ─────────────────────────────────────

const LIGHT_BOOST_MAX = 0.05;

export interface LightSleepResult {
  phase: 'light';
  groupDir: string;
  candidates: number;
  deduplicated: number;
  signals: number;
  timestamp: string;
}

export function lightSleep(groupDir: string): LightSleepResult {
  const timestamp = new Date().toISOString();

  // 1. Get recent recall candidates
  const candidates = getTopRecallCandidates(groupDir, 100, 2);

  // 2. Deduplicate (3-stage: SimHash → Jaccard → semantic)
  const deduped = dedupRecallEntries(candidates);

  // 3. Record reinforcement signals (but don't promote)
  const signalStore = loadPhaseSignals(groupDir);
  for (const entry of deduped) {
    signalStore.signals.push({
      phase: 'light',
      contentHash: entry.contentHash,
      boost: LIGHT_BOOST_MAX * entry.avgScore,
      timestamp,
    });
  }
  // Keep only last 500 signals
  signalStore.signals = signalStore.signals.slice(-500);
  savePhaseSignals(groupDir, signalStore);

  // 4. Rebuild knowledge graph from wikilinks
  try {
    buildGraph(groupDir);
  } catch (err) {
    logger.warn(
      { err, group: basename(groupDir) },
      'Knowledge graph rebuild failed (non-fatal)',
    );
  }

  // 5. Write light sleep report
  const reportDir = join(groupDir, '.dreams', 'light-sleep');
  if (!existsSync(reportDir))
    mkdirSync(reportDir, { recursive: true, mode: 0o777 });
  const report = {
    phase: 'light',
    timestamp,
    candidateCount: candidates.length,
    deduplicatedCount: deduped.length,
    topSnippets: deduped.slice(0, 5).map((e) => ({
      snippet: e.snippet.slice(0, 100),
      recallCount: e.recallCount,
      source: e.source,
    })),
  };
  writeFileSync(
    join(reportDir, `${timestamp.slice(0, 10)}.json`),
    JSON.stringify(report, null, 2),
  );

  return {
    phase: 'light',
    groupDir,
    candidates: candidates.length,
    deduplicated: deduped.length,
    signals: deduped.length,
    timestamp,
  };
}

// ─── Concept Tag Enrichment (Haiku LLM) ─────────────────────

const ENRICHMENT_BATCH_SIZE = 10;
const PROXY_URL = `http://${PROXY_BIND_HOST}:${CREDENTIAL_PROXY_PORT}`;

/**
 * Enrich concept tags for recall entries using Haiku LLM.
 * Called during light sleep for entries with weak/empty tags.
 * Batches snippets to minimize API calls.
 */
export async function enrichConceptTags(groupDir: string): Promise<number> {
  const store = loadRecallStore(groupDir);
  const entries = Object.values(store.entries);

  // Find entries needing enrichment: recallCount > 0 but tags are empty or trivial
  const needsEnrichment = entries
    .filter((e) => e.recallCount > 0 && e.conceptTags.length < 3)
    .slice(0, ENRICHMENT_BATCH_SIZE);

  if (needsEnrichment.length === 0) return 0;

  // Batch snippets into a single prompt
  const snippetsText = needsEnrichment
    .map((e, i) => `[${i}] ${e.snippet}`)
    .join('\n\n');

  try {
    const resp = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'placeholder',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `Extract 4-6 concept tags for each numbered snippet. Tags should be domain-specific nouns/phrases (not generic words). Output JSON array of arrays: [[tags for 0], [tags for 1], ...]. Tags in the same language as the snippet.`,
        messages: [{ role: 'user', content: snippetsText }],
      }),
    });

    if (!resp.ok) return 0;

    const data = (await resp.json()) as any;
    const text = data.content?.find((b: any) => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const tagArrays: string[][] = JSON.parse(jsonMatch[0]);
    let enriched = 0;

    for (
      let i = 0;
      i < Math.min(tagArrays.length, needsEnrichment.length);
      i++
    ) {
      const tags = tagArrays[i];
      if (Array.isArray(tags) && tags.length > 0) {
        const entry = store.entries[needsEnrichment[i].contentHash];
        if (entry) {
          entry.conceptTags = tags
            .slice(0, 8)
            .map((t) => String(t).toLowerCase());
          enriched++;
        }
      }
    }

    if (enriched > 0) {
      saveRecallStore(groupDir, store);
    }

    return enriched;
  } catch (err) {
    logger.debug(
      { err, group: basename(groupDir) },
      'Concept tag enrichment failed (non-fatal)',
    );
    return 0;
  }
}

// ─── Phase 2: REM Sleep ───────────────────────────────────────

const REM_BOOST_MAX = 0.08;
const MIN_PATTERN_STRENGTH = 0.75;

export interface RemSleepResult {
  phase: 'rem';
  groupDir: string;
  patterns: number;
  signals: number;
  timestamp: string;
}

export function remSleep(groupDir: string): RemSleepResult {
  const timestamp = new Date().toISOString();

  // 1. Get candidates from last 7 days
  const candidates = getTopRecallCandidates(groupDir, 100, 7);

  // 2. Find patterns — group by concept tags
  const tagGroups = new Map<string, RecallEntry[]>();
  for (const entry of candidates) {
    for (const tag of entry.conceptTags) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag)!.push(entry);
    }
  }

  // 3. Build theme summaries for strong patterns
  const patterns: Array<{ tag: string; entries: number; strength: number }> =
    [];
  const signalStore = loadPhaseSignals(groupDir);

  for (const [tag, entries] of tagGroups) {
    const strength = Math.min(entries.length / 5, 1);
    if (strength >= MIN_PATTERN_STRENGTH) {
      patterns.push({ tag, entries: entries.length, strength });

      // Record reinforcement signals
      for (const entry of entries) {
        signalStore.signals.push({
          phase: 'rem',
          contentHash: entry.contentHash,
          boost: REM_BOOST_MAX * strength,
          timestamp,
        });
      }
    }
  }

  signalStore.signals = signalStore.signals.slice(-500);
  savePhaseSignals(groupDir, signalStore);

  // 4. Build topic-level clusters (RAPTOR-like hierarchy)
  let topicCount = 0;
  try {
    const topics = buildTopics(groupDir, candidates);
    topicCount = topics.length;
  } catch (err) {
    logger.warn(
      { err, group: basename(groupDir) },
      'Hierarchy topic building failed (non-fatal)',
    );
  }

  // 5. Write REM report
  const reportDir = join(groupDir, '.dreams', 'rem-sleep');
  if (!existsSync(reportDir))
    mkdirSync(reportDir, { recursive: true, mode: 0o777 });
  writeFileSync(
    join(reportDir, `${timestamp.slice(0, 10)}.json`),
    JSON.stringify({ phase: 'rem', timestamp, patterns, topicCount }, null, 2),
  );

  return {
    phase: 'rem',
    groupDir,
    patterns: patterns.length,
    signals: signalStore.signals.length,
    timestamp,
  };
}

// ─── Phase 3: Deep Sleep ──────────────────────────────────────

export interface DeepSleepResult {
  phase: 'deep';
  groupDir: string;
  totalCandidates: number;
  promoted: number;
  rejected: number;
  promotedEntries: ScoredCandidate[];
  graphStats: { entities: number; relations: number };
  timestamp: string;
}

export function deepSleep(groupDir: string): DeepSleepResult {
  const timestamp = new Date().toISOString();

  // 0. Health check — prune stale entries, re-seed if needed
  const health = checkAndRecoverStore(groupDir);
  logger.info(
    {
      group: basename(groupDir),
      health: health.healthScore.toFixed(3),
      reseeded: health.reseeded,
    },
    'Deep sleep health check',
  );

  // 1. Get all candidates
  const candidates = getTopRecallCandidates(groupDir, 50, 30);
  const deduped = dedupRecallEntries(candidates, 3, 0.85);

  // 2. Compute phase signal boosts per entry
  const signalStore = loadPhaseSignals(groupDir);
  const phaseBoosts: Record<string, number> = {};
  for (const signal of signalStore.signals) {
    phaseBoosts[signal.contentHash] =
      (phaseBoosts[signal.contentHash] || 0) + signal.boost;
  }

  // 3. Score and rank (with phase boosts applied)
  const scored = rankCandidates(
    deduped,
    DEFAULT_WEIGHTS,
    DEFAULT_THRESHOLDS,
    phaseBoosts,
  );
  const promoted = scored.filter((s) => s.promoted);
  const rejected = scored.filter((s) => !s.promoted);

  // 4. Write promoted entries to MEMORY.md
  if (promoted.length > 0) {
    const memoryPath = join(groupDir, 'memory', 'MEMORY.md');
    const header = `\n\n## Dreaming Insights — ${timestamp.slice(0, 10)}\n\n`;
    const entries = promoted.map((s) => {
      const tags = s.entry.conceptTags.slice(0, 4).join(', ');
      return `- **[${tags}]** ${s.entry.snippet} _(score: ${s.score.toFixed(2)}, recalled ${s.entry.recallCount}x from ${s.entry.queryHashes.length} queries)_`;
    });

    const content = header + entries.join('\n') + '\n';

    if (existsSync(memoryPath)) {
      appendFileSync(memoryPath, content);
    } else {
      writeFileSync(
        memoryPath,
        `# Long-Term Memory\n\nAuto-promoted insights from dreaming.\n${content}`,
      );
    }
    try {
      require('fs').chmodSync(memoryPath, 0o666);
    } catch {
      /* ignore */
    }
  }

  // 5. Write deep sleep report
  const reportDir = join(groupDir, '.dreams', 'deep-sleep');
  if (!existsSync(reportDir))
    mkdirSync(reportDir, { recursive: true, mode: 0o777 });
  writeFileSync(
    join(reportDir, `${timestamp.slice(0, 10)}.json`),
    JSON.stringify(
      {
        phase: 'deep',
        timestamp,
        totalCandidates: candidates.length,
        promoted: promoted.map((s) => ({
          snippet: s.entry.snippet.slice(0, 100),
          score: s.score,
          breakdown: s.breakdown,
          source: s.entry.source,
        })),
        rejected: rejected.slice(0, 10).map((s) => ({
          snippet: s.entry.snippet.slice(0, 60),
          score: s.score,
          reason: s.reason,
        })),
      },
      null,
      2,
    ),
  );

  // 6. Rebuild knowledge graph from wikilinks
  let graphStats = { entities: 0, relations: 0 };
  try {
    graphStats = buildGraph(groupDir);
  } catch (err) {
    logger.warn(
      { err, group: basename(groupDir) },
      'Knowledge graph rebuild failed (non-fatal)',
    );
  }

  // 7. Build global-level patterns from topics
  try {
    buildGlobals(groupDir);
  } catch (err) {
    logger.warn(
      { err, group: basename(groupDir) },
      'Hierarchy globals failed (non-fatal)',
    );
  }

  return {
    phase: 'deep',
    groupDir,
    totalCandidates: candidates.length,
    promoted: promoted.length,
    rejected: rejected.length,
    promotedEntries: promoted,
    graphStats,
    timestamp,
  };
}

// ─── Store Health & Recovery ─────────────────────────────────

export interface StoreHealthReport {
  totalEntries: number;
  activeEntries: number; // recallCount > 0
  staleEntries: number; // not recalled in 30+ days
  healthScore: number; // 0-1
  reseeded: boolean;
}

/**
 * Check recall store health and re-seed from memory files if degraded.
 * Runs before deep sleep. Health score < 0.35 triggers a re-seed.
 */
export function checkAndRecoverStore(groupDir: string): StoreHealthReport {
  const store = loadRecallStore(groupDir);
  const entries = Object.values(store.entries);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const totalEntries = entries.length;
  const activeEntries = entries.filter((e) => e.recallCount > 0).length;
  const staleEntries = entries.filter(
    (e) => now - new Date(e.lastRecalled).getTime() > thirtyDaysMs,
  ).length;

  // Health score: weighted combination of activity ratio and freshness
  const activityRatio = totalEntries > 0 ? activeEntries / totalEntries : 0;
  const freshnessRatio = totalEntries > 0 ? 1 - staleEntries / totalEntries : 0;
  const healthScore = activityRatio * 0.6 + freshnessRatio * 0.4;

  let reseeded = false;

  if (healthScore < 0.35 && totalEntries > 0) {
    logger.info(
      {
        group: basename(groupDir),
        healthScore: healthScore.toFixed(3),
        activeEntries,
        staleEntries,
      },
      'Recall store health low, pruning stale entries',
    );

    // Prune entries that are stale AND have never been actively recalled
    for (const [hash, entry] of Object.entries(store.entries)) {
      const age = now - new Date(entry.lastRecalled).getTime();
      if (age > thirtyDaysMs && entry.recallCount === 0) {
        delete store.entries[hash];
      }
    }
    saveRecallStore(groupDir, store);
    reseeded = true;
  }

  return { totalEntries, activeEntries, staleEntries, healthScore, reseeded };
}

// ─── Full Dream Cycle ─────────────────────────────────────────

export interface DreamCycleResult {
  light: LightSleepResult;
  rem: RemSleepResult;
  deep: DeepSleepResult;
}

/**
 * Run all 3 phases in sequence for a group.
 */
export function dreamCycle(groupDir: string): DreamCycleResult {
  const light = lightSleep(groupDir);
  const rem = remSleep(groupDir);
  const deep = deepSleep(groupDir);
  return { light, rem, deep };
}

// ─── Group Setup ──────────────────────────────────────────────

/**
 * Initialize dreaming infrastructure for a new group.
 * Called when a new group is created — ensures everything works
 * out of the box without manual setup.
 */
export function setupGroupDreaming(groupDir: string): void {
  // Create .dreams directory
  const dreamsDir = join(groupDir, '.dreams');
  for (const sub of ['', 'light-sleep', 'rem-sleep', 'deep-sleep']) {
    const dir = join(dreamsDir, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o777 });
    }
  }

  // Create empty recall store
  const recallPath = join(dreamsDir, 'short-term-recall.json');
  if (!existsSync(recallPath)) {
    writeFileSync(
      recallPath,
      JSON.stringify(
        {
          version: 1,
          entries: {},
          lastUpdated: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    try {
      require('fs').chmodSync(recallPath, 0o666);
    } catch {
      /* ignore */
    }
  }

  // Create phase signals store
  const signalsPath = join(dreamsDir, 'phase-signals.json');
  if (!existsSync(signalsPath)) {
    writeFileSync(
      signalsPath,
      JSON.stringify(
        {
          signals: [],
          lastUpdated: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    try {
      require('fs').chmodSync(signalsPath, 0o666);
    } catch {
      /* ignore */
    }
  }

  // Add QMD collection for this group's memory
  const memoryDir = join(groupDir, 'memory');
  if (existsSync(memoryDir)) {
    const groupName = basename(groupDir);
    try {
      require('child_process').execSync(
        `qmd collection add "${memoryDir}" --name "${groupName}-memory"`,
        { stdio: 'pipe', timeout: 10000 },
      );
    } catch {
      /* QMD not installed or collection exists */
    }
  }

  // Add QMD collection for conversations
  const convDir = join(groupDir, 'conversations');
  if (existsSync(convDir)) {
    const groupName = basename(groupDir);
    try {
      require('child_process').execSync(
        `qmd collection add "${convDir}" --name "${groupName}-conversations"`,
        { stdio: 'pipe', timeout: 10000 },
      );
    } catch {
      /* QMD not installed or collection exists */
    }
  }
}
