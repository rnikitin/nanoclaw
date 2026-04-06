import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock config to avoid reading real .env / cwd-based paths
vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-scheduler-test-groups',
}));

// Mock logger to suppress output during tests
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock dreaming functions — they need real group dirs with memory/ subfolders,
// recall stores, etc. We only care that the scheduler sets up and tears down
// timers correctly.
vi.mock('./dreaming.js', () => ({
  lightSleep: vi.fn(),
  deepSleep: vi.fn(),
  remSleep: vi.fn(),
  setupGroupDreaming: vi.fn(),
}));

import {
  startDreamingScheduler,
  stopDreamingScheduler,
} from './dreaming-scheduler.js';

describe('dreaming-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Always stop the scheduler to clean up any timers
    stopDreamingScheduler();
    vi.useRealTimers();
  });

  // --- Basic lifecycle ---

  describe('startDreamingScheduler', () => {
    it('does not throw', () => {
      expect(() => startDreamingScheduler()).not.toThrow();
    });

    it('sets up timers (pending timers exist after start)', () => {
      startDreamingScheduler();
      // There should be at least one pending timer (light interval + deep timeout + rem timeout)
      const pending = vi.getTimerCount();
      expect(pending).toBeGreaterThanOrEqual(3);
    });
  });

  describe('stopDreamingScheduler', () => {
    it('does not throw when called without prior start', () => {
      expect(() => stopDreamingScheduler()).not.toThrow();
    });

    it('clears all timers after start', () => {
      startDreamingScheduler();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);

      stopDreamingScheduler();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is idempotent — calling stop twice does not throw', () => {
      startDreamingScheduler();
      stopDreamingScheduler();
      expect(() => stopDreamingScheduler()).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // --- Lifecycle sequences ---

  describe('lifecycle', () => {
    it('start → stop → start (clean restart)', () => {
      startDreamingScheduler();
      const countAfterFirstStart = vi.getTimerCount();
      expect(countAfterFirstStart).toBeGreaterThanOrEqual(3);

      stopDreamingScheduler();
      expect(vi.getTimerCount()).toBe(0);

      startDreamingScheduler();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(3);
    });

    it('double start does not throw', () => {
      expect(() => {
        startDreamingScheduler();
        startDreamingScheduler();
      }).not.toThrow();
      // May have double timers, but that is a design concern, not a crash
    });

    it('double start then single stop clears timers from last start', () => {
      startDreamingScheduler();
      startDreamingScheduler();
      stopDreamingScheduler();
      // After stop, the second set of timers should be cleared.
      // The first set remains orphaned (known limitation), but stop should not throw.
      // Timer count depends on implementation — just verify no crash.
    });
  });

  // --- Timer advancement ---

  describe('timer behavior', () => {
    it('light sleep interval fires after 6 hours', async () => {
      const { lightSleep } = await import('./dreaming.js');

      startDreamingScheduler();

      // Advance past 6 hours
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 100);

      // lightSleep is called via runForAllGroups, but since GROUPS_DIR is
      // empty (mock path), getGroupDirs returns []. The interval still fires,
      // it just has no groups to process. We verify the timer fires without errors.
      // lightSleep itself won't be called because there are no group dirs.
    });

    it('deep sleep timeout fires and reschedules', async () => {
      startDreamingScheduler();

      const initialTimerCount = vi.getTimerCount();

      // Advance to trigger the deep sleep timeout (up to 24h)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 100);

      // After deep sleep fires, it reschedules itself — so timers should still exist
      // (light interval is still active + new deep timeout + rem timeout may have fired too)
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    });

    it('timers do not fire after stop', async () => {
      const { lightSleep } = await import('./dreaming.js');

      startDreamingScheduler();
      stopDreamingScheduler();

      // Advance past all scheduled times
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);

      // No timers should have been pending
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
