/**
 * Set-based Jaccard similarity + word tokenizer shared across dreaming,
 * hierarchy, and dedup.
 */

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Lowercase, split on whitespace, drop words of length <= minLen.
 * Default minLen=3 matches dreaming's existing filter.
 */
export function tokenizeWords(text: string, minLen = 3): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > minLen);
}
