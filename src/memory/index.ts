/**
 * Memory Module — NanoClaw's memory management system.
 *
 * Provides:
 * - QMD-powered semantic search across group memory
 * - Recall tracking for dreaming scoring
 * - 3-phase dreaming (light/REM/deep sleep)
 * - Promotion scoring for long-term memory
 * - Auto-setup for new groups
 */

export { trackRecall, loadRecallStore, saveRecallStore, getTopRecallCandidates, getRecallStorePath } from './recall-tracker.js';
export type { RecallEntry, RecallStore } from './recall-tracker.js';

export { scoreCandidate, rankCandidates, DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS } from './promotion-scorer.js';
export type { PromotionWeights, PromotionThresholds, ScoredCandidate } from './promotion-scorer.js';

export { memorySearch, getQmdStatus } from './qmd-search.js';
export type { SearchResult, SearchOptions } from './qmd-search.js';

export { seedRecallStore, seedAllGroups } from './seed.js';
export type { SeedResult } from './seed.js';

export {
  lightSleep,
  remSleep,
  deepSleep,
  dreamCycle,
  setupGroupDreaming,
} from './dreaming.js';
export type {
  LightSleepResult,
  RemSleepResult,
  DeepSleepResult,
  DreamCycleResult,
} from './dreaming.js';

export {
  buildGraph,
  queryEntity,
  listEntities,
  findPath,
  getGraphStats,
} from './knowledge-graph.js';
export type {
  Entity,
  Relation,
  GraphQueryResult,
} from './knowledge-graph.js';

export {
  buildTopics,
  buildGlobals,
  retrieveAtLevel,
  loadHierarchy,
  clusterEntries,
} from './hierarchy.js';
export type {
  TopicCluster,
  MemoryLevel,
  HierarchyStore,
} from './hierarchy.js';

export { spreadActivation, enhanceWithActivation } from './spreading-activation.js';
export type { ActivationResult } from './spreading-activation.js';

export { dedup3Stage, dedupRecallEntries } from './dedup.js';
export type { DedupEntry, DedupResult } from './dedup.js';
