import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// vi.mock factory is hoisted above imports; vi.hoisted lets us create
// the tmpdir before the factory reads it.
const { tmpRoot } = vi.hoisted(() => {
  const fsLocal = require('fs');
  const osLocal = require('os');
  const pathLocal = require('path');
  return {
    tmpRoot: fsLocal.mkdtempSync(
      pathLocal.join(osLocal.tmpdir(), 'canvas-mw-'),
    ) as string,
  };
});

vi.mock('./config.js', () => ({
  GROUPS_DIR: tmpRoot,
  PROJECT_ROOT: tmpRoot,
  STORE_DIR: tmpRoot,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  loadConfig,
  matchMiddleware,
  runChain,
  _resetForTests,
  MAX_CHAIN_DEPTH,
} from './canvas-middleware.js';

const GROUP = 'test-group';

function groupDir(): string {
  return path.join(tmpRoot, GROUP, 'canvas-middleware');
}

function writeConfig(content: unknown): void {
  fs.mkdirSync(groupDir(), { recursive: true });
  fs.writeFileSync(
    path.join(groupDir(), 'config.json'),
    JSON.stringify(content, null, 2),
  );
}

function writeHandler(name: string, script: string): string {
  const p = path.join(groupDir(), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
  return name;
}

describe('canvas-middleware', () => {
  beforeEach(() => {
    _resetForTests();
    fs.rmSync(path.join(tmpRoot, GROUP), { recursive: true, force: true });
  });

  afterEach(() => {
    _resetForTests();
  });

  describe('loadConfig', () => {
    it('returns empty middleware array when config missing', () => {
      const cfg = loadConfig(GROUP);
      expect(cfg.middleware).toEqual([]);
    });

    it('returns empty when middleware key is not array', () => {
      writeConfig({ middleware: 'not-an-array' });
      const cfg = loadConfig(GROUP);
      expect(cfg.middleware).toEqual([]);
    });

    it('returns parsed rules', () => {
      writeConfig({
        middleware: [
          { id: 'a', direction: 'inbound', handler: 'a.sh' },
          { id: 'b', direction: 'outbound', handler: 'b.sh' },
        ],
      });
      const cfg = loadConfig(GROUP);
      expect(cfg.middleware).toHaveLength(2);
      expect(cfg.middleware[0].id).toBe('a');
    });
  });

  describe('matchMiddleware', () => {
    beforeEach(() => {
      writeConfig({
        middleware: [
          {
            id: 'inb-any',
            direction: 'inbound',
            priority: 10,
            handler: 'h.sh',
          },
          {
            id: 'inb-toggle',
            direction: 'inbound',
            priority: 5,
            match: { eventType: 'toggle_task' },
            handler: 'h.sh',
          },
          {
            id: 'both-render',
            direction: 'both',
            priority: 20,
            match: { eventName: 'nanoclaw.canvas.render' },
            handler: 'h.sh',
          },
          {
            id: 'outb-only',
            direction: 'outbound',
            priority: 1,
            handler: 'h.sh',
          },
          {
            id: 'canvas-scoped',
            direction: 'inbound',
            priority: 3,
            match: { canvasId: 'task-board' },
            handler: 'h.sh',
          },
        ],
      });
    });

    it('filters by direction (inbound excludes outbound)', () => {
      const m = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'foo',
        'any-canvas',
      );
      const ids = m.map((r) => r.id);
      expect(ids).toContain('inb-any');
      expect(ids).not.toContain('outb-only');
    });

    it('includes "both" when matching either direction', () => {
      const m = matchMiddleware(
        GROUP,
        'outbound',
        'nanoclaw.canvas.render',
        undefined,
        'any',
      );
      expect(m.map((r) => r.id)).toContain('both-render');
    });

    it('filters by eventType when rule requires it', () => {
      const m = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'toggle_task',
        'any',
      );
      expect(m.map((r) => r.id)).toContain('inb-toggle');

      const m2 = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'other_event',
        'any',
      );
      expect(m2.map((r) => r.id)).not.toContain('inb-toggle');
    });

    it('filters by canvasId when rule requires it', () => {
      const m = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'toggle_task',
        'task-board',
      );
      expect(m.map((r) => r.id)).toContain('canvas-scoped');

      const m2 = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'toggle_task',
        'other-canvas',
      );
      expect(m2.map((r) => r.id)).not.toContain('canvas-scoped');
    });

    it('sorts by priority ascending', () => {
      const m = matchMiddleware(
        GROUP,
        'inbound',
        'nanoclaw.canvas.interaction',
        'toggle_task',
        'task-board',
      );
      const priorities = m.map((r) => r.priority ?? 100);
      expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    });
  });

  describe('runChain', () => {
    it('runs passthrough handler and returns unchanged event', async () => {
      writeHandler(
        'pass.sh',
        '#!/bin/bash\ncat > /dev/null\necho \'{"next":true}\'\n',
      );
      writeConfig({
        middleware: [{ id: 'p', direction: 'inbound', handler: 'pass.sh' }],
      });

      const result = await runChain(
        {
          group: GROUP,
          canvasId: 'c1',
          direction: 'inbound',
          depth: 0,
        },
        { name: 'nanoclaw.canvas.interaction', value: { hello: 1 } },
      );

      expect(result.stopped).toBe(false);
      expect(result.sideEffectState).toBeUndefined();
    });

    it('stops chain on next:false', async () => {
      writeHandler(
        'stop.sh',
        '#!/bin/bash\ncat > /dev/null\necho \'{"next":false}\'\n',
      );
      writeHandler(
        'should-not-run.sh',
        '#!/bin/bash\ncat > /dev/null\ntouch /tmp/canvas-mw-should-not-run.marker\necho \'{"next":true}\'\n',
      );
      const marker = '/tmp/canvas-mw-should-not-run.marker';
      if (fs.existsSync(marker)) fs.unlinkSync(marker);

      writeConfig({
        middleware: [
          {
            id: 'first',
            direction: 'inbound',
            priority: 1,
            handler: 'stop.sh',
          },
          {
            id: 'second',
            direction: 'inbound',
            priority: 2,
            handler: 'should-not-run.sh',
          },
        ],
      });

      const result = await runChain(
        { group: GROUP, canvasId: 'c1', direction: 'inbound', depth: 0 },
        { name: 'nanoclaw.canvas.interaction', value: {} },
      );

      expect(result.stopped).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('propagates sideEffect.state to result', async () => {
      writeHandler(
        'side.sh',
        '#!/bin/bash\ncat > /dev/null\necho \'{"next":false,"sideEffect":{"state":{"tasks":[{"id":1}]}}}\'\n',
      );
      writeConfig({
        middleware: [{ id: 's', direction: 'inbound', handler: 'side.sh' }],
      });

      const result = await runChain(
        { group: GROUP, canvasId: 'c1', direction: 'inbound', depth: 0 },
        { name: 'nanoclaw.canvas.interaction', value: {} },
      );

      expect(result.stopped).toBe(true);
      expect(result.sideEffectState).toEqual({ tasks: [{ id: 1 }] });
    });

    it('fail-open: continues chain when handler exits non-zero', async () => {
      writeHandler(
        'broken.sh',
        '#!/bin/bash\ncat > /dev/null\necho "boom" >&2\nexit 1\n',
      );
      writeHandler(
        'after.sh',
        '#!/bin/bash\ncat > /dev/null\necho \'{"next":false}\'\n',
      );

      writeConfig({
        middleware: [
          { id: 'b', direction: 'inbound', priority: 1, handler: 'broken.sh' },
          { id: 'a', direction: 'inbound', priority: 2, handler: 'after.sh' },
        ],
      });

      const result = await runChain(
        { group: GROUP, canvasId: 'c1', direction: 'inbound', depth: 0 },
        { name: 'nanoclaw.canvas.interaction', value: {} },
      );

      expect(result.stopped).toBe(true);
    });

    it('fail-open: continues chain when handler times out', async () => {
      writeHandler(
        'slow.sh',
        '#!/bin/bash\ncat > /dev/null\nsleep 10\necho \'{"next":false}\'\n',
      );
      writeHandler(
        'after.sh',
        '#!/bin/bash\ncat > /dev/null\necho \'{"next":false,"sideEffect":{"state":{"reached":true}}}\'\n',
      );

      writeConfig({
        middleware: [
          {
            id: 'slow',
            direction: 'inbound',
            priority: 1,
            handler: 'slow.sh',
            timeout: 200,
          },
          {
            id: 'after',
            direction: 'inbound',
            priority: 2,
            handler: 'after.sh',
          },
        ],
      });

      const result = await runChain(
        { group: GROUP, canvasId: 'c1', direction: 'inbound', depth: 0 },
        { name: 'nanoclaw.canvas.interaction', value: {} },
      );

      expect(result.sideEffectState).toEqual({ reached: true });
    }, 10000);

    it('respects MAX_CHAIN_DEPTH — returns passthrough when exceeded', async () => {
      writeHandler(
        'should-not-run.sh',
        '#!/bin/bash\ncat > /dev/null\ntouch /tmp/canvas-mw-depth-marker\necho \'{"next":false}\'\n',
      );
      const marker = '/tmp/canvas-mw-depth-marker';
      if (fs.existsSync(marker)) fs.unlinkSync(marker);

      writeConfig({
        middleware: [
          {
            id: 'r',
            direction: 'inbound',
            handler: 'should-not-run.sh',
          },
        ],
      });

      const result = await runChain(
        {
          group: GROUP,
          canvasId: 'c1',
          direction: 'inbound',
          depth: MAX_CHAIN_DEPTH,
        },
        { name: 'nanoclaw.canvas.interaction', value: {} },
      );

      expect(result.stopped).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('passes input to handler via stdin', async () => {
      const outFile = path.join(tmpRoot, 'captured.json');
      writeHandler(
        'capture.sh',
        `#!/bin/bash\ncat > ${outFile}\necho '{"next":true}'\n`,
      );
      writeConfig({
        middleware: [{ id: 'c', direction: 'inbound', handler: 'capture.sh' }],
      });

      await runChain(
        { group: GROUP, canvasId: 'my-canvas', direction: 'inbound', depth: 0 },
        {
          name: 'nanoclaw.canvas.interaction',
          eventType: 'toggle_task',
          value: { taskId: 42 },
        },
      );

      const captured = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
      expect(captured.direction).toBe('inbound');
      expect(captured.canvasId).toBe('my-canvas');
      expect(captured.eventType).toBe('toggle_task');
      expect(captured.value).toEqual({ taskId: 42 });
    });
  });
});
