import { describe, expect, it } from 'vitest';

import {
  currentTokenPct,
  evaluateGroup,
  isWithinNightlyWindow,
  shouldReadUsageForAutoCompact,
} from './auto-compact.js';
import type { AutoCompactConfig } from './group-models.js';

const baseCfg: AutoCompactConfig = {
  enabled: true,
  idleEnabled: false,
  idleMinutes: 25,
  nightlyEnabled: true,
  nightlyUtcHour: 0,
  nightlyWindowMinutes: 30,
  minInputTokens: 50_000,
  cooldownMinutes: 10,
};

function usage(totalTokens: number, lastCompactAt?: number) {
  return {
    contextUsage: {
      totalTokens,
      maxTokens: 198_000,
    },
    lastCompact: lastCompactAt ? { firedAt: lastCompactAt } : undefined,
  };
}

describe('auto compact', () => {
  it('uses contextUsage total tokens before modelUsage fallback', () => {
    expect(
      currentTokenPct({
        contextUsage: { totalTokens: 75_000, maxTokens: 198_000 },
        modelUsage: {
          opus: {
            inputTokens: 1,
            contextWindow: 200_000,
          },
        },
      }),
    ).toEqual({
      inputTokens: 75_000,
      pct: (75_000 / 198_000) * 100,
    });
  });

  it('does not read usage outside the nightly window when idle is disabled', () => {
    const noonUtc = Date.UTC(2026, 4, 12, 12, 0, 0);

    expect(isWithinNightlyWindow(noonUtc, baseCfg)).toBe(false);
    expect(shouldReadUsageForAutoCompact(baseCfg, noonUtc)).toBe(false);
  });

  it('reads usage inside the nightly window', () => {
    const fivePastMidnightUtc = Date.UTC(2026, 4, 12, 0, 5, 0);

    expect(isWithinNightlyWindow(fivePastMidnightUtc, baseCfg)).toBe(true);
    expect(shouldReadUsageForAutoCompact(baseCfg, fivePastMidnightUtc)).toBe(
      true,
    );
  });

  it('fires nightly compact once in the nightly window above the token floor', () => {
    const fivePastMidnightUtc = Date.UTC(2026, 4, 12, 0, 5, 0);

    expect(
      evaluateGroup({
        usage: usage(50_000),
        lastActivityAt: null,
        lastAutoCompactAt: null,
        cfg: baseCfg,
        now: fivePastMidnightUtc,
      }),
    ).toMatchObject({
      fire: true,
      reason: 'nightly',
      inputTokens: 50_000,
    });
  });

  it('does not fire nightly compact after any compact in the same window', () => {
    const fivePastMidnightUtc = Date.UTC(2026, 4, 12, 0, 5, 0);
    const onePastMidnightUtc = Date.UTC(2026, 4, 12, 0, 1, 0);

    expect(
      evaluateGroup({
        usage: usage(80_000, onePastMidnightUtc),
        lastActivityAt: null,
        lastAutoCompactAt: null,
        cfg: { ...baseCfg, cooldownMinutes: 0 },
        now: fivePastMidnightUtc,
      }),
    ).toMatchObject({
      fire: false,
      reason: null,
    });
  });
});
