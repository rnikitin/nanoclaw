/**
 * Pure logic: should we fire /compact for this group right now?
 *
 * Token-based trigger is delegated to the SDK via
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW — fires in-process at ~76% of context.
 * This sweeper only handles the idle case the SDK can't see.
 *
 * Decides based on:
 *   - idle:   now - lastActivityAt exceeds idleMinutes (and tokens > 0)
 *   - cooldown: suppress if we fired within cooldownMinutes
 *
 * Called from the scheduler loop every SCHEDULER_POLL_INTERVAL (60s).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { ensureDir } from './fs-utils.js';
import { AutoCompactConfig } from './group-models.js';
import { sanitizeJid } from './jid-utils.js';

/**
 * Usage telemetry is written per-chatJid by the container runner. Keep the
 * path compute in one place so all readers/writers agree.
 */
export function usageFilePath(groupFolder: string, chatJid: string): string {
  return path.join(
    DATA_DIR,
    'ipc',
    groupFolder,
    'usage',
    `${sanitizeJid(chatJid)}.json`,
  );
}

export type AutoCompactReason = 'idle';

export interface AutoCompactDecision {
  fire: boolean;
  reason: AutoCompactReason | null;
  pct: number;
  inputTokens: number;
}

interface UsageSnapshot {
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      contextWindow: number;
    }
  >;
  lastCompact?: { firedAt?: number };
}

export function readUsage(
  groupFolder: string,
  chatJid: string,
): UsageSnapshot | null {
  const p = usageFilePath(groupFolder, chatJid);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Stamp lastCompact metadata into usage.json. Host-initiated writers use this
 * when a /compact is queued — preserves all other usage fields via read-merge-write.
 */
export function stampLastCompact(
  groupFolder: string,
  chatJid: string,
  reason: AutoCompactReason | 'manual',
): void {
  const p = usageFilePath(groupFolder, chatJid);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    // fall through: new file with just lastCompact
  }
  const snap = data as UsageSnapshot;
  const { pct, inputTokens } = currentTokenPct(snap);
  (data as Record<string, unknown>).lastCompact = {
    firedAt: Date.now(),
    reason,
    tokenPercentAtFire: Math.round(pct * 10) / 10,
    inputTokensAtFire: inputTokens,
  };
  try {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {
    // ignore — telemetry is best-effort
  }
}

/**
 * Pick the highest-percent usage across all models in the snapshot.
 * Handles the common case where only one model ran; also tolerates tiered mixes.
 */
export function currentTokenPct(usage: UsageSnapshot | null): {
  pct: number;
  inputTokens: number;
} {
  if (!usage || !usage.modelUsage) return { pct: 0, inputTokens: 0 };
  let best = { pct: 0, inputTokens: 0 };
  for (const u of Object.values(usage.modelUsage)) {
    if (!u.contextWindow || u.contextWindow <= 0) continue;
    const pct = (u.inputTokens / u.contextWindow) * 100;
    if (pct > best.pct) best = { pct, inputTokens: u.inputTokens };
  }
  return best;
}

export function evaluateGroup(params: {
  usage: UsageSnapshot | null;
  lastActivityAt: number | null;
  lastAutoCompactAt: number | null;
  cfg: AutoCompactConfig;
  now: number;
}): AutoCompactDecision {
  const { usage, lastActivityAt, lastAutoCompactAt, cfg, now } = params;
  const { pct, inputTokens } = currentTokenPct(usage);

  if (!cfg.enabled) return { fire: false, reason: null, pct, inputTokens };

  // Cooldown suppresses both triggers
  if (
    lastAutoCompactAt &&
    now - lastAutoCompactAt < cfg.cooldownMinutes * 60_000
  ) {
    return { fire: false, reason: null, pct, inputTokens };
  }

  // Also respect a compact that happened via the manual /compact path.
  // usage.lastCompact.firedAt is stamped for any compact (auto or manual).
  const lastCompactFiredAt = usage?.lastCompact?.firedAt ?? null;
  if (
    lastCompactFiredAt &&
    now - lastCompactFiredAt < cfg.cooldownMinutes * 60_000
  ) {
    return { fire: false, reason: null, pct, inputTokens };
  }

  // Treat the last compact as pseudo-activity so the idle timer restarts
  // after a compaction — prevents repeated firing on a still-idle group.
  const effectiveLastActivity =
    Math.max(lastActivityAt ?? 0, lastCompactFiredAt ?? 0) || null;

  if (
    effectiveLastActivity &&
    inputTokens > 0 &&
    now - effectiveLastActivity >= cfg.idleMinutes * 60_000
  ) {
    return { fire: true, reason: 'idle', pct, inputTokens };
  }

  return { fire: false, reason: null, pct, inputTokens };
}
