/**
 * Three-Stage Deduplication — SimHash → Jaccard → Semantic.
 *
 * Stage 1: SimHash — 64-bit fingerprint, Hamming distance <= 3 = duplicate (fastest)
 * Stage 2: MinHash (Jaccard on word shingles) — similarity >= 0.85 = duplicate
 * Stage 3: (Optional) vector cosine — would need embeddings, skipped for now
 *
 * Replaces the simple Jaccard-only dedup in dreaming.ts.
 */

import { jaccard } from './similarity.js';

// ─── Stage 1: SimHash ───────────────────────────────────────

/** Generate a 32-bit SimHash fingerprint for text. */
function simhash(text: string): number {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return 0;

  const bits = 32;
  const v = new Array(bits).fill(0);

  for (const word of words) {
    const hash = fnv1a(word);
    for (let i = 0; i < bits; i++) {
      if ((hash >> i) & 1) {
        v[i]++;
      } else {
        v[i]--;
      }
    }
  }

  let fingerprint = 0;
  for (let i = 0; i < bits; i++) {
    if (v[i] > 0) fingerprint |= 1 << i;
  }
  return fingerprint;
}

/** FNV-1a hash (32-bit). */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Count differing bits (Hamming distance). */
function hammingDistance(a: number, b: number): number {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += xor & 1;
    xor >>>= 1;
  }
  return count;
}

// ─── Stage 2: MinHash / Jaccard ──────────────────────────────

/** Generate word shingles (n-grams of words). */
function shingles(text: string, n = 3): Set<string> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const result = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    result.add(words.slice(i, i + n).join(' '));
  }
  // Also add individual words as fallback for short texts
  if (words.length < n) {
    for (const w of words) result.add(w);
  }
  return result;
}


// ─── Three-Stage Pipeline ────────────────────────────────────

export interface DedupEntry {
  id: string;
  text: string;
}

export interface DedupResult {
  unique: DedupEntry[];
  duplicates: Array<{ entry: DedupEntry; duplicateOf: string; stage: number }>;
}

/**
 * Deduplicate entries using 3-stage pipeline.
 * Returns unique entries and identified duplicates with the stage that caught them.
 */
export function dedup3Stage(
  entries: DedupEntry[],
  simhashThreshold = 3,
  jaccardThreshold = 0.85,
): DedupResult {
  if (entries.length === 0) return { unique: [], duplicates: [] };

  const unique: DedupEntry[] = [];
  const duplicates: Array<{
    entry: DedupEntry;
    duplicateOf: string;
    stage: number;
  }> = [];

  // Pre-compute fingerprints and shingles for all entries
  const fingerprints: number[] = [];
  const shinglSets: Set<string>[] = [];

  for (const entry of entries) {
    fingerprints.push(simhash(entry.text));
    shinglSets.push(shingles(entry.text));
  }

  // Track which entries are accepted (by index in unique[])
  const acceptedFingerprints: number[] = [];
  const acceptedShingles: Set<string>[] = [];
  const acceptedIds: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fp = fingerprints[i];
    const sh = shinglSets[i];
    let isDuplicate = false;

    // Stage 1: SimHash — fastest check
    for (let j = 0; j < acceptedFingerprints.length; j++) {
      if (hammingDistance(fp, acceptedFingerprints[j]) <= simhashThreshold) {
        duplicates.push({ entry, duplicateOf: acceptedIds[j], stage: 1 });
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    // Stage 2: Jaccard on shingles — catches rephrasings
    for (let j = 0; j < acceptedShingles.length; j++) {
      if (jaccard(sh, acceptedShingles[j]) >= jaccardThreshold) {
        duplicates.push({ entry, duplicateOf: acceptedIds[j], stage: 2 });
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    // Passed both stages — this entry is unique
    unique.push(entry);
    acceptedFingerprints.push(fp);
    acceptedShingles.push(sh);
    acceptedIds.push(entry.id);
  }

  return { unique, duplicates };
}

/**
 * Convenience wrapper for RecallEntry dedup.
 */
export function dedupRecallEntries<
  T extends { contentHash: string; snippet: string },
>(entries: T[], simhashThreshold = 3, jaccardThreshold = 0.85): T[] {
  if (entries.length <= 1) return entries;

  const dedupInput: DedupEntry[] = entries.map((e) => ({
    id: e.contentHash,
    text: e.snippet,
  }));

  const result = dedup3Stage(dedupInput, simhashThreshold, jaccardThreshold);
  const uniqueIds = new Set(result.unique.map((u) => u.id));

  return entries.filter((e) => uniqueIds.has(e.contentHash));
}
