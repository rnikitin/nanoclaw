/**
 * Script Runner for NanoClaw
 * Spawns independent agent containers for script-mode scheduled tasks.
 * These containers bypass GroupQueue — they have no timeout and aren't
 * affected by incoming messages.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  MAX_CONCURRENT_SCRIPTS,
} from './config.js';
import {
  buildContainerArgs,
  buildVolumeMounts,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { ensureDir } from './fs-utils.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface RunningScript {
  process: ChildProcess;
  containerName: string;
  taskId: string;
}

const runningScripts = new Map<string, RunningScript>();

export function getRunningScriptTaskIds(): Set<string> {
  return new Set(runningScripts.keys());
}

export function isScriptRunning(taskId: string): boolean {
  return runningScripts.has(taskId);
}

export function getRunningScriptCount(): number {
  return runningScripts.size;
}

export async function stopScript(taskId: string): Promise<void> {
  const script = runningScripts.get(taskId);
  if (!script) return;

  logger.info(
    { taskId, containerName: script.containerName },
    'Stopping script container',
  );

  try {
    stopContainer(script.containerName);
  } catch (err) {
    logger.warn({ taskId, err }, 'Graceful script stop failed, force killing');
    script.process.kill('SIGKILL');
  }
}

export async function stopAllScripts(): Promise<void> {
  const tasks = Array.from(runningScripts.keys());
  await Promise.all(tasks.map((taskId) => stopScript(taskId)));
}

export async function runScriptTask(
  task: ScheduledTask,
  group: RegisteredGroup,
  isMain: boolean,
  sessionId: string | undefined,
): Promise<ContainerOutput> {
  if (runningScripts.size >= MAX_CONCURRENT_SCRIPTS) {
    logger.warn(
      { taskId: task.id, running: runningScripts.size },
      'Max concurrent scripts reached, skipping',
    );
    return {
      status: 'error',
      result: null,
      error: `Max concurrent scripts (${MAX_CONCURRENT_SCRIPTS}) reached`,
    };
  }

  if (runningScripts.has(task.id)) {
    logger.warn({ taskId: task.id }, 'Script task already running, skipping');
    return {
      status: 'error',
      result: null,
      error: 'Script task is already running',
    };
  }

  const groupDir = resolveGroupFolderPath(group.folder);
  ensureDir(groupDir);

  const mounts = buildVolumeMounts(group, isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-script-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, group.folder);

  const input: ContainerInput = {
    prompt: task.prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid: task.chat_jid,
    isMain,
    isScheduledTask: true,
  };

  logger.info(
    { taskId: task.id, group: group.name, containerName },
    'Spawning script container (no timeout)',
  );

  const logsDir = path.join(groupDir, 'logs');
  ensureDir(logsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `script-${task.id}-${ts}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    runningScripts.set(task.id, {
      process: container,
      containerName,
      taskId: task.id,
    });

    let stdout = '';
    let stdoutTruncated = false;
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let lastResult: string | null = null;

    // Close mechanism: after the agent produces a result, write _close sentinel
    // so the agent-runner exits its waitForIpcMessage loop.
    const SCRIPT_CLOSE_DELAY_MS = 10_000;
    const SCRIPT_FORCE_STOP_MS = 60_000;
    let closeScheduled = false;
    let scriptCloseTimer: ReturnType<typeof setTimeout> | null = null;
    let scriptForceTimer: ReturnType<typeof setTimeout> | null = null;
    const groupIpcDir = resolveGroupIpcPath(group.folder);

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      logStream.write(chunk);

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
        } else {
          stdout += chunk;
        }
      }

      // Parse output markers
      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) newSessionId = parsed.newSessionId;
          if (parsed.result) lastResult = parsed.result;

          // Schedule container close after first real result
          if (parsed.result && !parsed.isThinking && !closeScheduled) {
            closeScheduled = true;
            scriptCloseTimer = setTimeout(() => {
              logger.info(
                { taskId: task.id },
                'Writing _close for script container after result',
              );
              const inputDir = path.join(groupIpcDir, 'input');
              try {
                ensureDir(inputDir);
                fs.writeFileSync(path.join(inputDir, '_close'), '');
              } catch (err) {
                logger.warn(
                  { taskId: task.id, err },
                  'Failed to write _close for script',
                );
              }
              // Force-stop safety net
              scriptForceTimer = setTimeout(() => {
                logger.warn(
                  { taskId: task.id },
                  'Force-stopping script container (did not exit after _close)',
                );
                try {
                  stopContainer(containerName);
                } catch {
                  container.kill('SIGKILL');
                }
              }, SCRIPT_FORCE_STOP_MS);
            }, SCRIPT_CLOSE_DELAY_MS);
          }
        } catch (err) {
          logger.warn(
            { taskId: task.id, error: err },
            'Failed to parse script output chunk',
          );
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      logStream.write(chunk);
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ script: task.id }, line);
      }
    });

    // NO timeout — script runs until completion or manual stop

    container.on('close', (code) => {
      if (scriptCloseTimer) clearTimeout(scriptCloseTimer);
      if (scriptForceTimer) clearTimeout(scriptForceTimer);
      runningScripts.delete(task.id);
      logStream.end();

      // If we initiated the close after capturing a result, treat as success
      // even if exit code is non-zero (e.g. from force-stop via docker stop/SIGKILL)
      const status =
        closeScheduled && lastResult
          ? 'success'
          : code === 0
            ? 'success'
            : 'error';
      logger.info(
        { taskId: task.id, containerName, code, status, closeScheduled },
        'Script container exited',
      );

      resolve({
        status: status as 'success' | 'error',
        result: lastResult,
        newSessionId,
        error:
          status === 'error' ? `Script exited with code ${code}` : undefined,
      });
    });

    container.on('error', (err) => {
      runningScripts.delete(task.id);
      logStream.end();

      logger.error(
        { taskId: task.id, containerName, error: err },
        'Script container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Script spawn error: ${err.message}`,
      });
    });
  });
}
