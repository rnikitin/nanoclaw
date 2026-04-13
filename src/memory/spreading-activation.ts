/**
 * Spreading Activation — graph-based memory retrieval enhancement.
 *
 * When searching for memories, activation "spreads" from matching
 * entities through the knowledge graph to related entities.
 * This surfaces contextually relevant memories that don't directly
 * match the query but are connected to matching entities.
 *
 * Based on the Synapse paper (Jiang et al., 2026): +23% accuracy
 * on multi-hop reasoning tasks.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

import { openDb } from '../db-open.js';

// ─── Cache ───────────────────────────────────────────────────

// Read-only DB handles cached per groupDir. Called on every memory_search —
// avoid re-opening the graph DB for each query.
const dbCache = new Map<string, Database.Database>();
let exitHandlerRegistered = false;

function getReadonlyDb(dbPath: string, groupDir: string): Database.Database {
  const cached = dbCache.get(groupDir);
  if (cached) return cached;
  const db = openDb(dbPath, { readonly: true });
  dbCache.set(groupDir, db);
  if (!exitHandlerRegistered) {
    process.on('exit', () => {
      for (const h of dbCache.values()) {
        try {
          h.close();
        } catch {
          /* ignore */
        }
      }
      dbCache.clear();
    });
    exitHandlerRegistered = true;
  }
  return db;
}

/** @internal — test-only helper to release cached read-only handles. */
export function _closeSpreadingActivationHandles(): void {
  for (const h of dbCache.values()) {
    try {
      h.close();
    } catch {
      /* ignore */
    }
  }
  dbCache.clear();
}

// ─── Types ───────────────────────────────────────────────────

export interface ActivationResult {
  entity: string;
  activation: number;
  hops: number;
}

// ─── Spreading Activation ────────────────────────────────────

/**
 * Spread activation from seed entities through the knowledge graph.
 *
 * @param groupDir - Group directory containing the graph DB
 * @param seeds - Initial entities to activate (from query matches)
 * @param maxHops - Maximum distance to spread (default 2)
 * @param decayFactor - Activation decay per hop (default 0.7)
 * @param minActivation - Minimum activation to keep (default 0.1)
 */
export function spreadActivation(
  groupDir: string,
  seeds: string[],
  maxHops = 2,
  decayFactor = 0.7,
  minActivation = 0.1,
): ActivationResult[] {
  const dbPath = join(groupDir, '.dreams', 'knowledge-graph.db');
  if (!existsSync(dbPath)) return [];

  const db = getReadonlyDb(dbPath, groupDir);

  const activations = new Map<string, { activation: number; hops: number }>();

  // Seed entities get full activation
  for (const seed of seeds) {
    activations.set(seed.toLowerCase(), { activation: 1.0, hops: 0 });
  }

  // BFS spreading
  let frontier = seeds.map((s) => s.toLowerCase());

  for (let hop = 1; hop <= maxHops; hop++) {
    const nextFrontier: string[] = [];
    const currentDecay = Math.pow(decayFactor, hop);

    for (const current of frontier) {
      // Get all neighbors
      const neighbors = db
        .prepare(
          `
          SELECT to_entity as neighbor FROM relations WHERE LOWER(from_entity) = ?
          UNION
          SELECT from_entity as neighbor FROM relations WHERE LOWER(to_entity) = ?
        `,
        )
        .all(current, current) as Array<{ neighbor: string }>;

      for (const { neighbor } of neighbors) {
        const key = neighbor.toLowerCase();
        const existing = activations.get(key);
        const newActivation = currentDecay;

        if (!existing || existing.activation < newActivation) {
          activations.set(key, { activation: newActivation, hops: hop });
          if (newActivation >= minActivation) {
            nextFrontier.push(key);
          }
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return [...activations.entries()]
    .map(([entity, { activation, hops }]) => ({ entity, activation, hops }))
    .filter((r) => r.activation >= minActivation)
    .sort((a, b) => b.activation - a.activation);
}

/**
 * Enhance search results with spreading activation.
 * Takes existing search results and boosts scores for entities
 * connected to the query's matched entities.
 */
export function enhanceWithActivation(
  groupDir: string,
  queryEntities: string[],
  results: Array<{ content: string; score: number }>,
  boostWeight = 0.15,
): Array<{ content: string; score: number; activationBoost: number }> {
  if (queryEntities.length === 0)
    return results.map((r) => ({ ...r, activationBoost: 0 }));

  const activations = spreadActivation(groupDir, queryEntities);
  const activationMap = new Map(
    activations.map((a) => [a.entity, a.activation]),
  );

  return results.map((result) => {
    // Check if any activated entity appears in this result
    let maxBoost = 0;
    const contentLower = result.content.toLowerCase();
    for (const [entity, activation] of activationMap) {
      if (contentLower.includes(entity)) {
        maxBoost = Math.max(maxBoost, activation);
      }
    }

    const activationBoost = maxBoost * boostWeight;
    return {
      ...result,
      score: result.score + activationBoost,
      activationBoost,
    };
  });
}
