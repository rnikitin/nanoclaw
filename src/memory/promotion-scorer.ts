/**
 * Promotion Scorer — 6-weight scoring system for Deep Sleep.
 *
 * Determines which short-term memories get promoted to long-term (MEMORY.md).
 * Adapted from OpenClaw's dreaming system.
 */

import type { RecallEntry } from './recall-tracker.js';

export interface PromotionWeights {
  frequency: number;    // Signal accumulation count
  relevance: number;    // Average retrieval quality
  diversity: number;    // Distinct query/day contexts
  recency: number;      // Time-decayed freshness
  consolidation: number; // Multi-day recurrence strength
  conceptual: number;   // Concept-tag density
}

export interface PromotionThresholds {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  maxAgeDays: number;
}

export interface ScoredCandidate {
  entry: RecallEntry;
  score: number;
  breakdown: Record<string, number>;
  promoted: boolean;
  reason?: string;
}

export const DEFAULT_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.30,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptual: 0.06,
};

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  minScore: 0.6,
  minRecallCount: 2,
  minUniqueQueries: 2,
  maxAgeDays: 30,
};

const RECENCY_HALF_LIFE_DAYS = 14;

/**
 * Score a recall entry for promotion to long-term memory.
 * Returns a value between 0 and 1.
 * @param phaseBoost — accumulated boost from light/REM sleep phases (0-1)
 */
export function scoreCandidate(
  entry: RecallEntry,
  weights: PromotionWeights = DEFAULT_WEIGHTS,
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
  phaseBoost = 0,
): ScoredCandidate {
  const now = Date.now();
  const ageMs = now - new Date(entry.firstSeen).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  // Skip if too old
  if (ageDays > thresholds.maxAgeDays) {
    return {
      entry,
      score: 0,
      breakdown: {},
      promoted: false,
      reason: `Too old: ${ageDays.toFixed(0)} days > ${thresholds.maxAgeDays}`,
    };
  }

  // 1. Frequency — normalized recall count (log scale, cap at ~20)
  const frequencyRaw = Math.min(Math.log2(entry.recallCount + 1) / Math.log2(21), 1);

  // 2. Relevance — average retrieval score (already 0-1)
  const relevanceRaw = Math.min(entry.avgScore, 1);

  // 3. Diversity — unique queries / max queries (normalized)
  const diversityRaw = Math.min(entry.queryHashes.length / 10, 1);

  // 4. Recency — exponential decay with 14-day half-life
  const lastRecalledAge = (now - new Date(entry.lastRecalled).getTime()) / (24 * 60 * 60 * 1000);
  const recencyRaw = Math.exp(-0.693 * lastRecalledAge / RECENCY_HALF_LIFE_DAYS);

  // 5. Consolidation — multi-day recurrence (unique days / max days)
  const consolidationRaw = Math.min(entry.recallDays.length / 7, 1);

  // 6. Conceptual — concept tag density (tags / max tags)
  const conceptualRaw = Math.min(entry.conceptTags.length / 8, 1);

  const breakdown = {
    frequency: frequencyRaw,
    relevance: relevanceRaw,
    diversity: diversityRaw,
    recency: recencyRaw,
    consolidation: consolidationRaw,
    conceptual: conceptualRaw,
  };

  const baseScore =
    weights.frequency * frequencyRaw +
    weights.relevance * relevanceRaw +
    weights.diversity * diversityRaw +
    weights.recency * recencyRaw +
    weights.consolidation * consolidationRaw +
    weights.conceptual * conceptualRaw;

  // Apply phase boost from light/REM sleep (capped at 1.3x multiplier)
  const boostMultiplier = 1 + Math.min(phaseBoost, 0.3);
  const score = Math.min(baseScore * boostMultiplier, 1);

  // Check promotion gates
  let promoted = true;
  let reason: string | undefined;

  if (score < thresholds.minScore) {
    promoted = false;
    reason = `Score ${score.toFixed(3)} < ${thresholds.minScore}`;
  } else if (entry.recallCount < thresholds.minRecallCount) {
    promoted = false;
    reason = `RecallCount ${entry.recallCount} < ${thresholds.minRecallCount}`;
  } else if (entry.queryHashes.length < thresholds.minUniqueQueries) {
    promoted = false;
    reason = `UniqueQueries ${entry.queryHashes.length} < ${thresholds.minUniqueQueries}`;
  }

  return { entry, score, breakdown, promoted, reason };
}

/**
 * Score and rank all candidates, returning promoted ones.
 * @param phaseBoosts — map of contentHash → accumulated boost from light/REM phases
 */
export function rankCandidates(
  entries: RecallEntry[],
  weights: PromotionWeights = DEFAULT_WEIGHTS,
  thresholds: PromotionThresholds = DEFAULT_THRESHOLDS,
  phaseBoosts: Record<string, number> = {},
): ScoredCandidate[] {
  return entries
    .map(e => scoreCandidate(e, weights, thresholds, phaseBoosts[e.contentHash] || 0))
    .sort((a, b) => b.score - a.score);
}
