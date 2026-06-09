import { ChildProcess, spawn } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

import {
  evaluateGroup,
  readUsage,
  shouldReadUsageForAutoCompact,
} from './auto-compact.js';
import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  buildContainerArgs,
  buildVolumeMounts,
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { ensureDir } from './fs-utils.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { resolveGroupAutoCompact } from './group-models.js';
import { logger } from './logger.js';
import {
  getRunningScriptTaskIds,
  isScriptRunning,
  runScriptTask,
} from './script-runner.js';
import { RegisteredGroup, ScheduledTask, TaskSnapshotRow } from './types.js';

/**
 * Build the task-row shape that gets written to every group's IPC snapshot.
 * Shared by runAgent (per-spawn), the scheduler loop, and onTasksChanged,
 * so the mapping is defined once.
 */
export function buildTaskSnapshotRows(): TaskSnapshotRow[] {
  const tasks = getAllTasks();
  const runningIds = getRunningScriptTaskIds();
  return tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
    execution_mode: t.execution_mode,
    precondition: t.precondition ?? null,
    precondition_invert: !!t.precondition_invert,
    is_running: runningIds.has(t.id),
  }));
}

/**
 * Compute the initial next_run when a task is first scheduled or its
 * schedule is changed via IPC. Unlike `computeNextRun` (which anchors
 * to an existing next_run to prevent drift on recurring intervals),
 * this variant starts fresh from Date.now() / the once-date.
 */
export function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      return interval.next().toISOString();
    } catch {
      return null;
    }
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) return null;
    return new Date(Date.now() + ms).toISOString();
  }
  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  }
  return null;
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

const PRECONDITION_TIMEOUT_MS = 60_000;

interface PreconditionResult {
  passed: boolean;
  exitCode: number | null;
  outputTail: string;
  timedOut: boolean;
}

/**
 * Run a task's precondition: a one-shot bash container (no agent-runner, no
 * LLM) that decides whether the real task should fire this cycle. Reuses the
 * task's volume mounts and env so checks can use python/ccxt from pkg-cache
 * and read /workspace/group. Exit 0 → fire (non-zero → fire when inverted).
 */
async function runPrecondition(
  task: ScheduledTask,
  group: RegisteredGroup,
  isMain: boolean,
): Promise<PreconditionResult> {
  const precondition = task.precondition;
  if (!precondition) {
    return { passed: true, exitCode: 0, outputTail: '', timedOut: false };
  }

  const mounts = buildVolumeMounts(group, isMain, task.chat_jid);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-precond-${safeName}-${Date.now()}`;
  const baseArgs = buildContainerArgs(
    mounts,
    containerName,
    group.folder,
    task.chat_jid,
  );

  // buildContainerArgs ends with the image name. Splice `--entrypoint bash`
  // in before it and append `-c <precondition>` after, turning the agent
  // image into a plain one-shot bash runner.
  const image = baseArgs[baseArgs.length - 1];
  const args = [
    ...baseArgs.slice(0, -1),
    '--entrypoint',
    '/bin/bash',
    image,
    '-c',
    precondition,
  ];

  return new Promise<PreconditionResult>((resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        stopContainer(containerName);
      } catch {
        proc.kill('SIGKILL');
      }
      resolve({
        passed: false,
        exitCode: null,
        outputTail: (stderr || stdout).slice(-500),
        timedOut: true,
      });
    }, PRECONDITION_TIMEOUT_MS);

    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: null,
        outputTail: String(err).slice(-500),
        timedOut: false,
      });
    });

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? 1;
      const invert = !!task.precondition_invert;
      const passed = invert ? exitCode !== 0 : exitCode === 0;
      resolve({
        passed,
        exitCode,
        outputTail: (stderr || stdout).slice(-500),
        timedOut: false,
      });
    });
  });
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  ensureDir(groupDir);

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  writeTasksSnapshot(task.group_folder, isMain, buildTaskSnapshotRows());

  // Precondition gate: a cheap bash check runs before we spend an LLM
  // container. If it doesn't pass, log a 'skipped' run, advance next_run,
  // and return without firing the real task.
  if (task.precondition) {
    const gate = await runPrecondition(task, group, isMain);
    if (!gate.passed) {
      const reason = gate.timedOut
        ? 'precondition timeout'
        : `precondition gate (exit ${gate.exitCode})`;
      logger.info(
        {
          taskId: task.id,
          exitCode: gate.exitCode,
          timedOut: gate.timedOut,
        },
        'Task skipped by precondition',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'skipped',
        result: null,
        error: gate.outputTail ? `${reason}: ${gate.outputTail}` : reason,
      });
      const nextRun = computeNextRun(task);
      updateTaskAfterRun(task.id, nextRun, `Skipped (${reason})`);
      return;
    }
    logger.info({ taskId: task.id }, 'Precondition passed, firing task');
  }

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.chat_jid] : undefined;

  if (task.execution_mode === 'script') {
    // Script mode: bypass GroupQueue, no timeout, independent container
    try {
      const output = await runScriptTask(task, group, isMain, sessionId);

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      }
      if (output.result) {
        result = output.result;
        try {
          await deps.sendMessage(task.chat_jid, output.result);
        } catch (sendErr) {
          logger.error(
            { taskId: task.id, error: sendErr },
            'Failed to send script task result',
          );
        }
      }

      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Script task completed',
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'Script task failed');
    }
  } else {
    // Agent mode: standard container through GroupQueue
    // After the task produces a result, close the container promptly.
    // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
    // query loop to time out. A short delay handles any final MCP calls.
    const TASK_CLOSE_DELAY_MS = 10_000;
    const TASK_FORCE_STOP_MS = 60_000;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let forceStopTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleClose = () => {
      if (closeTimer) return; // already scheduled
      closeTimer = setTimeout(() => {
        logger.debug(
          { taskId: task.id },
          'Closing task container after result',
        );
        deps.queue.closeStdin(task.chat_jid);
        // Safety net: force-stop if container doesn't exit after _close
        forceStopTimer = setTimeout(() => {
          logger.warn(
            { taskId: task.id },
            'Force-stopping task container (did not exit after _close)',
          );
          deps.queue.forceStop(task.chat_jid);
        }, TASK_FORCE_STOP_MS);
      }, TASK_CLOSE_DELAY_MS);
    };

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt: task.prompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
        },
        (proc, containerName) =>
          deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            result = streamedOutput.result;
            scheduleClose(); // Always schedule close before sendMessage
            try {
              await deps.sendMessage(task.chat_jid, streamedOutput.result);
            } catch (err) {
              logger.error(
                { taskId: task.id, error: err },
                'Failed to send task result',
              );
            }
          }
          if (streamedOutput.status === 'success') {
            deps.queue.notifyIdle(task.chat_jid);
            scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
          }
          if (streamedOutput.status === 'error') {
            error = streamedOutput.error || 'Unknown error';
          }
        },
      );

      if (closeTimer) clearTimeout(closeTimer);
      if (forceStopTimer) clearTimeout(forceStopTimer);

      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      }
      if (output.result) {
        // Result was already forwarded to the user via the streaming callback above
        result = output.result;
      }

      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Task completed',
      );
    } catch (err) {
      if (closeTimer) clearTimeout(closeTimer);
      if (forceStopTimer) clearTimeout(forceStopTimer);
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'Task failed');
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

/**
 * Walk all registered groups, read their usage.json snapshot, and decide
 * whether to fire an auto-compact. Fires via GroupQueue.queueAutoCompact,
 * which dedupes via an in-memory flag.
 */
function sweepAutoCompact(deps: SchedulerDependencies): void {
  const groups = deps.registeredGroups();
  const now = Date.now();
  for (const [chatJid, group] of Object.entries(groups)) {
    try {
      const cfg = resolveGroupAutoCompact(group.folder);
      if (!shouldReadUsageForAutoCompact(cfg, now)) continue;
      const lastActivityAt = deps.queue.getLastActivityAt(chatJid) || null;
      const usage = readUsage(group.folder, chatJid);
      const decision = evaluateGroup({
        usage,
        lastActivityAt,
        lastAutoCompactAt: null, // cooldown honored via usage.lastCompact.firedAt
        cfg,
        now,
      });
      if (!decision.fire || !decision.reason) continue;
      const queued = deps.queue.queueAutoCompact(chatJid, decision.reason);
      if (queued) {
        logger.info(
          {
            group: group.name,
            reason: decision.reason,
            pct: decision.pct.toFixed(1),
            inputTokens: decision.inputTokens,
          },
          'Auto-compact queued',
        );
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'sweepAutoCompact error');
    }
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        if (currentTask.execution_mode === 'script') {
          // Script tasks bypass GroupQueue — spawn independently.
          // Skip if the previous run is still executing: otherwise runScriptTask's
          // "already running" guard returns an error, which would be written as
          // last_result and prematurely advance next_run past the in-flight run.
          if (isScriptRunning(currentTask.id)) {
            logger.debug(
              { taskId: currentTask.id },
              'Script task still running, skipping scheduler fire',
            );
            continue;
          }
          runTask(currentTask, deps).catch((err) =>
            logger.error({ taskId: currentTask.id, err }, 'Script task error'),
          );
        } else {
          deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
            runTask(currentTask, deps),
          );
        }
      }

      sweepAutoCompact(deps);
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
