import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCanvasServer, setResolveChatJid } from './canvas-server.js';
import { initCanvasStore } from './canvas-store.js';
import {
  startDreamingScheduler,
  stopDreamingScheduler,
} from './memory/dreaming-scheduler.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { extractSkillFromSession } from './skill-extractor.js';
import { startSkillPromoter, stopSkillPromoter } from './skill-promoter.js';
import { initSkillTracker } from './skill-tracker.js';
import {
  cleanupOrphans,
  CONTAINER_RUNTIME_BIN,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { parseImageReferences } from './image.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { stampLastCompact } from './auto-compact.js';
import { getRunningScriptTaskIds, stopAllScripts } from './script-runner.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Read persisted usage data and format a human-readable report.
 */
function formatUsageReport(
  groupFolder: string,
  thinkingEnabled?: boolean,
): string {
  const usagePath = path.join(DATA_DIR, 'ipc', groupFolder, 'usage.json');
  let data: {
    model?: string;
    thinkingEnabled?: boolean;
    totalCostUsd?: number;
    numTurns?: number;
    durationMs?: number;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        contextWindow: number;
        maxOutputTokens: number;
        costUSD: number;
      }
    >;
    updatedAt?: number;
  };

  try {
    data = JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
  } catch {
    return 'No usage data yet. Send a message first.';
  }

  const lines: string[] = [];

  // Model & mode
  if (data.model) {
    const thinking = data.thinkingEnabled ?? thinkingEnabled;
    lines.push(`**Model:** ${data.model}${thinking ? ' (thinking ON)' : ''}`);
  }

  // Session usage from last query
  const entries = Object.entries(data.modelUsage || {});
  if (entries.length > 0) {
    lines.push('');
    lines.push('**Last query usage:**');
    for (const [model, u] of entries) {
      const pct =
        u.contextWindow > 0
          ? ((u.inputTokens / u.contextWindow) * 100).toFixed(1)
          : '?';
      // Flag non-default context windows so a surprise 1M beta is obvious
      const cwMarker =
        u.contextWindow > 200000 ? ` ⚠ ${u.contextWindow / 1000}K beta` : '';
      lines.push(
        `  ${model}${cwMarker}` +
          `\n    Context: ${u.inputTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()} tokens (${pct}%)` +
          `\n    Output: ${u.outputTokens.toLocaleString()} / ${u.maxOutputTokens.toLocaleString()} tokens` +
          (u.cacheReadInputTokens > 0
            ? `\n    Cache read: ${u.cacheReadInputTokens.toLocaleString()} tokens`
            : '') +
          (u.cacheCreationInputTokens > 0
            ? `\n    Cache write: ${u.cacheCreationInputTokens.toLocaleString()} tokens`
            : '') +
          `\n    Cost: $${u.costUSD.toFixed(4)}`,
      );
    }
    if (data.totalCostUsd != null) {
      lines.push(
        `\n  **Total:** $${data.totalCostUsd.toFixed(4)}` +
          (data.numTurns ? ` (${data.numTurns} turns)` : '') +
          (data.durationMs
            ? ` in ${(data.durationMs / 1000).toFixed(1)}s`
            : ''),
      );
    }
  }

  // Rate limits (from credential proxy headers)
  const rateLimitsPath = path.join(DATA_DIR, 'rate-limits.json');
  let rateLimits: {
    fiveHour?: { utilization: number; reset?: number };
    sevenDay?: { utilization: number; reset?: number };
    updatedAt?: number;
  } | null = null;
  try {
    rateLimits = JSON.parse(fs.readFileSync(rateLimitsPath, 'utf-8'));
  } catch {
    /* no rate limit data yet */
  }

  if (rateLimits && (rateLimits.fiveHour || rateLimits.sevenDay)) {
    lines.push('');
    lines.push('**Rate limits:**');

    const formatWindow = (
      label: string,
      window?: { utilization: number; reset?: number },
    ): string | null => {
      if (!window) return null;
      const pct = (window.utilization * 100).toFixed(1);
      const emoji =
        window.utilization < 0.5
          ? '🟢'
          : window.utilization < 0.8
            ? '🟡'
            : '🔴';
      let line = `  ${emoji} ${label}: ${pct}% used`;
      if (window.reset) {
        const diffMs = window.reset * 1000 - Date.now();
        if (diffMs > 0) {
          const totalMin = Math.round(diffMs / 60000);
          const days = Math.floor(totalMin / 1440);
          const hrs = Math.floor((totalMin % 1440) / 60);
          const mins = totalMin % 60;
          const parts: string[] = [];
          if (days > 0) parts.push(`${days}d`);
          if (hrs > 0) parts.push(`${hrs}h`);
          if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
          line += ` (resets in ${parts.join(' ')})`;
        }
      }
      return line;
    };

    const fiveLine = formatWindow('5h', rateLimits.fiveHour);
    const sevenLine = formatWindow('7d', rateLimits.sevenDay);
    if (fiveLine) lines.push(fiveLine);
    if (sevenLine) lines.push(sevenLine);
  } else {
    lines.push('\n_Rate limit info not yet available_');
  }

  return lines.join('\n');
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  // Consume any pending auto-compact: append a synthetic /compact message so
  // the existing handleSessionCommand path handles pre-compact processing,
  // SDK compact, and newSessionId persistence uniformly.
  const autoCompactPending = queue.consumePendingAutoCompact(chatJid);
  if (autoCompactPending) {
    stampLastCompact(group.folder, autoCompactPending.reason);
    missedMessages.push({
      id: `autocompact-${Date.now()}`,
      chat_jid: chatJid,
      sender: 'system',
      sender_name: 'system',
      content: '/compact',
      timestamp: new Date().toISOString(),
      is_from_me: true,
    });
    logger.info(
      {
        group: group.name,
        reason: autoCompactPending.reason,
        preCompactCount: missedMessages.length - 1,
      },
      'Auto-compact: injecting synthetic /compact',
    );
  }

  if (missedMessages.length === 0) return true;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    groupFolder: group.folder,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      closeActiveContainer: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
      reboot: () => {
        logger.info('Restart requested via /restart command');
        process.exit(0);
      },
      autoUpdate: async () => {
        logger.info('Auto-update requested via /auto-update command');

        // 1. Get current versions from the container image
        const currentCmd = [
          'npm ls -g @anthropic-ai/claude-code --depth=0 --json 2>/dev/null',
          'npm ls -g agent-browser --depth=0 --json 2>/dev/null',
          'gh --version 2>/dev/null | head -1',
        ].join(' && echo "---SEP---" && ');
        const { stdout: currentRaw } = await execAsync(
          `${CONTAINER_RUNTIME_BIN} run --rm --entrypoint bash ${CONTAINER_IMAGE} -c '${currentCmd}'`,
          { timeout: 60_000 },
        );
        const currentParts = currentRaw.split('---SEP---').map((s) => s.trim());

        const parseNpmVersion = (json: string, pkg: string): string => {
          try {
            const data = JSON.parse(json);
            return data.dependencies?.[pkg]?.version || 'unknown';
          } catch {
            return 'unknown';
          }
        };

        const currentVersions = {
          'claude-code': parseNpmVersion(
            currentParts[0],
            '@anthropic-ai/claude-code',
          ),
          'agent-browser': parseNpmVersion(currentParts[1], 'agent-browser'),
          gh: currentParts[2]?.match(/(\d+\.\d+\.\d+)/)?.[1] || 'unknown',
        };

        // 2. Get latest available versions
        const [claudeLatest, abLatest, ghLatest] = await Promise.all([
          execAsync('npm view @anthropic-ai/claude-code version')
            .then((r) => r.stdout.trim())
            .catch(() => 'unknown'),
          execAsync('npm view agent-browser version')
            .then((r) => r.stdout.trim())
            .catch(() => 'unknown'),
          execAsync(
            'curl -sf https://api.github.com/repos/cli/cli/releases/latest',
          )
            .then((r) => {
              try {
                return (
                  JSON.parse(r.stdout).tag_name?.replace(/^v/, '') || 'unknown'
                );
              } catch {
                return 'unknown';
              }
            })
            .catch(() => 'unknown'),
        ]);

        const latestVersions = {
          'claude-code': claudeLatest,
          'agent-browser': abLatest,
          gh: ghLatest,
        };

        // 3. Compare and build report
        const packages = ['claude-code', 'agent-browser', 'gh'] as const;
        const lines: string[] = [];
        let needsRebuild = false;

        for (const pkg of packages) {
          const cur = currentVersions[pkg];
          const lat = latestVersions[pkg];
          if (cur === 'unknown' || lat === 'unknown') {
            lines.push(`${pkg}: ${cur} (latest: ${lat})`);
          } else if (cur !== lat) {
            lines.push(`${pkg}: ${cur} → ${lat} ⬆`);
            needsRebuild = true;
          } else {
            lines.push(`${pkg}: ${cur} ✓`);
          }
        }

        const report = lines.join('\n');

        if (!needsRebuild) {
          return {
            report: `All packages up to date.\n\n${report}`,
            rebuilt: false,
          };
        }

        // 4. Rebuild
        const buildScript = path.join(process.cwd(), 'container', 'build.sh');
        await execAsync(buildScript, { timeout: 300_000 });

        return {
          report: `Updates found, container rebuilt.\n\n${report}\n\nRestarting...`,
          rebuilt: true,
        };
      },
      resetSession: () => {
        delete sessions[group.folder];
        deleteSession(group.folder);
      },
      toggleThinking: () => {
        const cfg = group.containerConfig || {};
        cfg.enableThinking = !cfg.enableThinking;
        group.containerConfig = cfg;
        registeredGroups[chatJid] = group;
        setRegisteredGroup(chatJid, group);
        logger.info(
          { group: group.name, enableThinking: cfg.enableThinking },
          'Thinking mode toggled',
        );
        return cfg.enableThinking!;
      },
      getUsageReport: () =>
        formatUsageReport(group.folder, group.containerConfig?.enableThinking),
    },
  });
  if (cmdResult.handled) {
    // Advance cursor past these messages so they don't get re-processed
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return cmdResult.success;
  }
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let lastThinkingText = '';

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Keepalive from background tasks — reset idle timer, nothing else
      if (result.isKeepalive) {
        resetIdleTimer();
        return;
      }
      // Streaming output callback — called for each agent result
      if (result.isThinking && result.result) {
        // Thinking progress — send without italic to preserve markdown
        const text =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        if (text.trim()) {
          lastThinkingText = text.trim();
          try {
            await channel.sendMessage(chatJid, text.trim().slice(0, 2000));
          } catch (err) {
            logger.error(
              { group: group.name, error: err },
              'Failed to send thinking update',
            );
          }
        }
        resetIdleTimer();
      } else if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text === lastThinkingText) {
          // Skip — already sent as thinking progress
          lastThinkingText = '';
        } else {
          lastThinkingText = '';
          if (text) {
            try {
              await channel.sendMessage(chatJid, text);
              outputSentToUser = true;
            } catch (err) {
              logger.error(
                { group: group.name, error: err },
                'Failed to send agent output',
              );
            }
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Fire-and-forget: extract reusable skills from completed sessions
  if (output !== 'error' && !hadError) {
    let numTurns: number | undefined;
    try {
      const usagePath = path.join(DATA_DIR, 'ipc', group.folder, 'usage.json');
      const usage = JSON.parse(fs.readFileSync(usagePath, 'utf-8'));
      numTurns = usage.numTurns;
    } catch {
      /* no usage data */
    }

    extractSkillFromSession(group.folder, numTurns).catch((err) => {
      logger.debug(
        { group: group.name, err },
        'Skill extraction failed (non-fatal)',
      );
    });
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  const runningIds = getRunningScriptTaskIds();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      execution_mode: t.execution_mode,
      is_running: runningIds.has(t.id),
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
        ...(group.containerConfig?.enableThinking && { thinkingEnabled: true }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Fast-path host-only session commands so they don't wait behind an active
 * container in the GroupQueue. Returns true if handled inline.
 *
 * Compute the reply synchronously, then fire sendMessage without awaiting.
 * Awaiting here would stall the entire startMessageLoop on a single slow
 * Telegram chat — e.g. per-chat flood-wait hanging grammy's HTTP request —
 * preventing every other group from being polled.
 */
function handleHostOnlyInline(
  cmd: string,
  cmdMsg: NewMessage,
  group: RegisteredGroup,
  channel: Channel,
  chatJid: string,
  batchLastTimestamp: string,
): boolean {
  if (cmd !== '/usage' && cmd !== '/thinking' && cmd !== '/new') return false;
  const isMainGroup = group.isMain === true;
  if (!isSessionCommandAllowed(isMainGroup, !!cmdMsg.is_from_me)) return false;

  let reply: string;
  try {
    if (cmd === '/usage') {
      reply = formatUsageReport(
        group.folder,
        group.containerConfig?.enableThinking,
      );
    } else if (cmd === '/thinking') {
      const cfg = group.containerConfig || {};
      cfg.enableThinking = !cfg.enableThinking;
      group.containerConfig = cfg;
      registeredGroups[chatJid] = group;
      setRegisteredGroup(chatJid, group);
      reply = `Thinking mode: ${cfg.enableThinking ? 'ON' : 'OFF'}`;
    } else {
      // /new: close any running container first — otherwise its tail output
      // would call setSession with the OLD session ID and undo the reset.
      queue.closeStdin(chatJid);
      delete sessions[group.folder];
      deleteSession(group.folder);
      reply = 'New session started.';
    }
  } catch (err) {
    logger.warn(
      { chatJid, cmd, err },
      'Host-only inline handler failed; falling back to queue',
    );
    return false;
  }

  channel.sendMessage(chatJid, reply).catch((err) =>
    logger.warn({ chatJid, cmd, err }, 'Host-only inline sendMessage failed'),
  );

  lastAgentTimestamp[chatJid] = batchLastTimestamp;
  saveState();
  return true;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          queue.markActivity(chatJid);

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            const cmd = extractSessionCommand(
              loopCmdMsg.content,
              TRIGGER_PATTERN,
            );
            const batchLastTs =
              groupMessages[groupMessages.length - 1].timestamp;
            if (
              cmd &&
              handleHostOnlyInline(
                cmd,
                loopCmdMsg,
                group,
                channel,
                chatJid,
                batchLastTs,
              )
            ) {
              continue;
            }
            // Host-only commands that don't need the container — skip closeStdin
            const hostOnlyCommands = new Set([
              '/usage',
              '/thinking',
              '/restart',
            ]);
            // Only close active container if the sender is authorized AND the
            // command actually needs a fresh container (e.g. /compact).
            if (
              !hostOnlyCommands.has(cmd || '') &&
              isSessionCommandAllowed(isMainGroup, !!loopCmdMsg.is_from_me)
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Check for session commands in pending messages before piping to container.
          // This catches commands sent while a container is already active.
          const pendingCmdMsg = messagesToSend.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );
          if (pendingCmdMsg) {
            const pendingCmd = extractSessionCommand(
              pendingCmdMsg.content,
              TRIGGER_PATTERN,
            );
            const batchLastTs =
              messagesToSend[messagesToSend.length - 1].timestamp;
            if (
              pendingCmd &&
              handleHostOnlyInline(
                pendingCmd,
                pendingCmdMsg,
                group,
                channel,
                chatJid,
                batchLastTs,
              )
            ) {
              continue;
            }
            const hostOnly = new Set(['/usage', '/thinking', '/restart']);
            if (
              !hostOnly.has(pendingCmd || '') &&
              isSessionCommandAllowed(isMainGroup, !!pendingCmdMsg.is_from_me)
            ) {
              queue.closeStdin(chatJid);
            }
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Initialize canvas persistent store
  initCanvasStore();

  // Initialize skill tracker (usage metrics + auto-skill registry)
  initSkillTracker();
  startSkillPromoter();

  // Wire up canvas chatJid resolver
  setResolveChatJid((group: string) => {
    for (const [jid, g] of Object.entries(registeredGroups)) {
      if (g.folder === group) return jid;
    }
    return null;
  });

  // Start Canvas HTTP server (web UI ↔ agent interaction)
  const canvasServer = await startCanvasServer().catch((err) => {
    logger.warn({ err }, 'Canvas server failed to start (non-fatal)');
    return null;
  });

  // Send a lifecycle notification to all main groups
  const notifyMainGroups = async (text: string) => {
    for (const [jid, group] of Object.entries(registeredGroups)) {
      if (!group.isMain) continue;
      const ch = findChannel(channels, jid);
      if (ch) {
        await ch.sendMessage(jid, text).catch(() => {});
      }
    }
  };

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await notifyMainGroups(`${ASSISTANT_NAME} is restarting...`);
    proxyServer.close();
    canvasServer?.close();
    stopDreamingScheduler();
    stopSkillPromoter();
    await stopAllScripts();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile)
        throw new Error(
          `Channel ${channel.name} does not support file sending`,
        );
      return channel.sendFile(jid, filePath, caption);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const runningIds = getRunningScriptTaskIds();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
        execution_mode: t.execution_mode,
        is_running: runningIds.has(t.id),
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startDreamingScheduler();
  const startLoop = () => {
    startMessageLoop().catch((err) => {
      logger.error({ err }, 'Message loop crashed — restarting in 5s');
      messageLoopRunning = false;
      setTimeout(startLoop, 5000);
    });
  };
  startLoop();

  await notifyMainGroups(`${ASSISTANT_NAME} is online.`);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
