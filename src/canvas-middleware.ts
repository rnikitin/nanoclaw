/**
 * Canvas Middleware — Express-style interceptor chain for AG-UI events.
 *
 * Channels/skills drop `groups/{group}/canvas-middleware/config.json` +
 * handler scripts. Canvas-server runs matching middlewares in priority
 * order before forwarding inbound events to LLM or outbound events to WS.
 *
 * Per-group, hot-reloaded (fs.watch on config.json), fail-open on handler
 * crash/timeout, sequential chain with max recursion depth 2.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';

export type Direction = 'inbound' | 'outbound';

export interface MiddlewareMatch {
  eventName?: string; // AG-UI event name, e.g. "nanoclaw.canvas.interaction"
  eventType?: string; // Inner value.event (inbound) or Custom name suffix
  canvasId?: string;
}

export interface MiddlewareRule {
  id: string;
  direction: Direction | 'both';
  priority?: number;
  match?: MiddlewareMatch;
  handler: string; // Relative path from canvas-middleware/ dir
  timeout?: number; // ms, default 3000
}

export interface MiddlewareConfig {
  middleware: MiddlewareRule[];
}

export interface ChainContext {
  group: string;
  canvasId: string;
  direction: Direction;
  depth: number;
}

export interface HandlerInput {
  direction: Direction;
  group: string;
  canvasId: string;
  eventName: string;
  eventType?: string;
  value: unknown;
  threadId?: string;
  runId?: string;
}

export interface HandlerOutput {
  next?: boolean; // default true — continue chain
  event?: unknown; // replacement event for downstream chain + final broadcast
  sideEffect?: {
    state?: Record<string, unknown>; // merge into canvas state + re-render
  };
}

export interface ChainResult {
  stopped: boolean;
  event: unknown; // possibly modified
  sideEffectState?: Record<string, unknown>;
}

export const MAX_CHAIN_DEPTH = 2;
const DEFAULT_TIMEOUT = 3000;

// Per-group config cache. Key: group name.
const configCache = new Map<string, MiddlewareConfig>();
const watchers = new Map<string, fs.FSWatcher>();
const reloadTimers = new Map<string, NodeJS.Timeout>();

function configPath(group: string): string {
  return path.join(GROUPS_DIR, group, 'canvas-middleware', 'config.json');
}

function middlewareDir(group: string): string {
  return path.join(GROUPS_DIR, group, 'canvas-middleware');
}

export function loadConfig(group: string): MiddlewareConfig {
  const p = configPath(group);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as MiddlewareConfig;
    if (!Array.isArray(parsed.middleware)) {
      logger.warn({ group, path: p }, 'Canvas middleware config missing array');
      return { middleware: [] };
    }
    return parsed;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      logger.warn(
        { err, group, path: p },
        'Canvas middleware config load failed',
      );
    }
    return { middleware: [] };
  }
}

function ensureWatcher(group: string): void {
  if (watchers.has(group)) return;
  const p = configPath(group);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) return;

  try {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== 'config.json') return;
      const existing = reloadTimers.get(group);
      if (existing) clearTimeout(existing);
      reloadTimers.set(
        group,
        setTimeout(() => {
          reloadTimers.delete(group);
          configCache.set(group, loadConfig(group));
          logger.info({ group }, 'Canvas middleware config reloaded');
        }, 100),
      );
    });
    watchers.set(group, watcher);
  } catch (err) {
    logger.debug({ err, group }, 'Canvas middleware watcher setup failed');
  }
}

export function getConfig(group: string): MiddlewareConfig {
  let cfg = configCache.get(group);
  if (!cfg) {
    cfg = loadConfig(group);
    configCache.set(group, cfg);
    ensureWatcher(group);
  }
  return cfg;
}

/**
 * Return matching rules sorted by priority (lower first).
 */
export function matchMiddleware(
  group: string,
  direction: Direction,
  eventName: string,
  eventType?: string,
  canvasId?: string,
): MiddlewareRule[] {
  const cfg = getConfig(group);
  const matches = cfg.middleware.filter((m) => {
    if (m.direction !== direction && m.direction !== 'both') return false;
    const match = m.match || {};
    if (match.eventName && match.eventName !== eventName) return false;
    if (match.eventType && match.eventType !== eventType) return false;
    if (match.canvasId && match.canvasId !== canvasId) return false;
    return true;
  });
  matches.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  return matches;
}

/**
 * Spawn a handler script. stdin = JSON input; stdout = JSON output.
 * Timeout kills the process and returns null (fail-open signal).
 */
export async function runHandler(
  group: string,
  rule: MiddlewareRule,
  input: HandlerInput,
): Promise<HandlerOutput | null> {
  const scriptPath = path.resolve(middlewareDir(group), rule.handler);
  const timeout = rule.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(scriptPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOCLAW_GROUP: group,
          NANOCLAW_GROUP_DIR: path.join(GROUPS_DIR, group),
          NANOCLAW_CANVAS_ID: input.canvasId,
        },
      });
    } catch (err) {
      logger.warn(
        { err, group, ruleId: rule.id, scriptPath },
        'Canvas middleware handler spawn failed',
      );
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const finish = (result: HandlerOutput | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger.warn(
        { group, ruleId: rule.id, timeout },
        'Canvas middleware handler timed out',
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeout);

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', (err) => {
      logger.warn(
        { err, group, ruleId: rule.id },
        'Canvas middleware handler error',
      );
      finish(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn(
          { group, ruleId: rule.id, code, stderr: stderr.slice(0, 500) },
          'Canvas middleware handler exited non-zero',
        );
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}') as HandlerOutput;
        finish(parsed);
      } catch (err) {
        logger.warn(
          { err, group, ruleId: rule.id, stdout: stdout.slice(0, 500) },
          'Canvas middleware handler produced invalid JSON',
        );
        finish(null);
      }
    });

    try {
      child.stdin?.write(JSON.stringify(input));
      child.stdin?.end();
    } catch (err) {
      logger.warn(
        { err, group, ruleId: rule.id },
        'Canvas middleware handler stdin write failed',
      );
      finish(null);
    }
  });
}

/**
 * Run the matching middleware chain. Sequential, fail-open.
 * Stops as soon as a handler returns `next: false`.
 */
export async function runChain(
  ctx: ChainContext,
  initialEvent: {
    name: string;
    eventType?: string;
    value: unknown;
    threadId?: string;
    runId?: string;
  },
): Promise<ChainResult> {
  if (ctx.depth >= MAX_CHAIN_DEPTH) {
    return { stopped: false, event: initialEvent };
  }

  const rules = matchMiddleware(
    ctx.group,
    ctx.direction,
    initialEvent.name,
    initialEvent.eventType,
    ctx.canvasId,
  );

  let currentEvent: {
    name: string;
    eventType?: string;
    value: unknown;
    threadId?: string;
    runId?: string;
  } = { ...initialEvent };
  let sideEffectState: Record<string, unknown> | undefined;

  for (const rule of rules) {
    const input: HandlerInput = {
      direction: ctx.direction,
      group: ctx.group,
      canvasId: ctx.canvasId,
      eventName: currentEvent.name,
      eventType: currentEvent.eventType,
      value: currentEvent.value,
      threadId: currentEvent.threadId,
      runId: currentEvent.runId,
    };
    const output = await runHandler(ctx.group, rule, input);
    if (output === null) continue; // fail-open

    if (output.sideEffect?.state) {
      sideEffectState = {
        ...(sideEffectState || {}),
        ...output.sideEffect.state,
      };
    }

    if (output.event) {
      const replaced = output.event as {
        name?: string;
        eventType?: string;
        value?: unknown;
      };
      currentEvent = {
        name: replaced.name ?? currentEvent.name,
        eventType: replaced.eventType ?? currentEvent.eventType,
        value: replaced.value ?? currentEvent.value,
        threadId: currentEvent.threadId,
        runId: currentEvent.runId,
      };
    }

    if (output.next === false) {
      return { stopped: true, event: currentEvent, sideEffectState };
    }
  }

  return { stopped: false, event: currentEvent, sideEffectState };
}

/**
 * Close all watchers. Called on shutdown.
 */
export function closeAllWatchers(): void {
  for (const [group, w] of watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
    watchers.delete(group);
  }
  for (const [group, t] of reloadTimers) {
    clearTimeout(t);
    reloadTimers.delete(group);
  }
}

/**
 * Test-only: clear caches. Not for production use.
 */
export function _resetForTests(): void {
  closeAllWatchers();
  configCache.clear();
}
