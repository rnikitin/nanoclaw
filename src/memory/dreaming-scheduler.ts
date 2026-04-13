/**
 * Dreaming Scheduler — runs memory consolidation phases on a schedule.
 *
 * Schedule:
 * - Light Sleep: every 6 hours
 * - Deep Sleep: daily at 3:00 AM local time
 * - REM Sleep: weekly on Sundays at 5:00 AM local time
 *
 * Runs in-process (no containers needed). Each group dreams independently.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  lightSleep,
  remSleep,
  deepSleep,
  enrichConceptTags,
  setupGroupDreaming,
} from './dreaming.js';

const LIGHT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEEP_SLEEP_HOUR = 3; // 3 AM local time
const REM_SLEEP_DAY = 0; // Sunday
const REM_SLEEP_HOUR = 5; // 5 AM local time

let lightTimer: ReturnType<typeof setInterval> | null = null;
let deepTimer: ReturnType<typeof setTimeout> | null = null;
let remTimer: ReturnType<typeof setTimeout> | null = null;

function getGroupDirs(): string[] {
  try {
    return readdirSync(GROUPS_DIR)
      .map((dir) => join(GROUPS_DIR, dir))
      .filter((dir) => existsSync(join(dir, 'memory')));
  } catch {
    return [];
  }
}

function runForAllGroups(
  phase: 'light' | 'deep' | 'rem',
  fn: (groupDir: string) => unknown,
): void {
  const groups = getGroupDirs();
  for (const groupDir of groups) {
    try {
      setupGroupDreaming(groupDir);
      const result = fn(groupDir);
      logger.info(
        { phase, group: groupDir.split('/').pop(), result },
        'Dreaming phase completed',
      );
    } catch (err) {
      logger.error(
        { phase, group: groupDir.split('/').pop(), err },
        'Dreaming phase failed',
      );
    }
  }
}

function msUntilNextHour(targetHour: number, targetDay?: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(targetHour, 0, 0, 0);

  if (targetDay !== undefined) {
    // Find next occurrence of target day
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    next.setDate(
      now.getDate() + (daysUntil === 0 && now >= next ? 7 : daysUntil),
    );
  } else if (now >= next) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

function scheduleDeepSleep(): void {
  const ms = msUntilNextHour(DEEP_SLEEP_HOUR);
  logger.info(
    { nextRunIn: `${(ms / 3600000).toFixed(1)}h` },
    'Deep sleep scheduled',
  );

  deepTimer = setTimeout(() => {
    runForAllGroups('deep', deepSleep);
    scheduleDeepSleep(); // Reschedule for tomorrow
  }, ms);
}

function scheduleRemSleep(): void {
  const ms = msUntilNextHour(REM_SLEEP_HOUR, REM_SLEEP_DAY);
  logger.info(
    { nextRunIn: `${(ms / 3600000).toFixed(1)}h` },
    'REM sleep scheduled',
  );

  remTimer = setTimeout(() => {
    runForAllGroups('rem', remSleep);
    scheduleRemSleep(); // Reschedule for next week
  }, ms);
}

export function startDreamingScheduler(): void {
  // Light sleep: every 6 hours starting now (first run after 6h)
  // After light sleep, enrich concept tags via Haiku LLM
  lightTimer = setInterval(() => {
    runForAllGroups('light', lightSleep);
    // Async enrichment — fire and forget
    for (const groupDir of getGroupDirs()) {
      enrichConceptTags(groupDir).catch((err) => {
        logger.debug(
          { err, group: groupDir.split('/').pop() },
          'Tag enrichment failed (non-fatal)',
        );
      });
    }
  }, LIGHT_INTERVAL_MS);

  // Deep sleep: daily at 3 AM
  scheduleDeepSleep();

  // REM sleep: Sundays at 5 AM
  scheduleRemSleep();

  logger.info(
    'Dreaming scheduler started (light: 6h, deep: 3AM daily, REM: Sun 5AM)',
  );
}

export function stopDreamingScheduler(): void {
  if (lightTimer) clearInterval(lightTimer);
  if (deepTimer) clearTimeout(deepTimer);
  if (remTimer) clearTimeout(remTimer);
  lightTimer = null;
  deepTimer = null;
  remTimer = null;
}
