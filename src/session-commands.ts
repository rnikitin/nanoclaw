import { exec } from 'child_process';
import { promisify } from 'util';

import type { NewMessage } from './types.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  // Strip Telegram bot suffix (e.g. /usage@botname → /usage)
  const command = text.replace(/@\S+$/, '').trim();
  if (command === '/compact') return '/compact';
  if (command === '/usage') return '/usage';
  if (command === '/restart') return '/restart';
  if (command === '/thinking') return '/thinking';
  if (command === '/new') return '/new';
  if (command === '/auto-update') return '/auto-update';
  if (command === '/effort' || command.startsWith('/effort ')) return command;
  if (command.startsWith('/dreaming')) return command;
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), or trusted/admin sender (is_from_me) in any group.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
): boolean {
  return isMainGroup || isFromMe;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Trigger graceful process restart (for /restart). */
  reboot: () => void;
  /** Toggle thinking mode for this group. Returns new state. */
  toggleThinking: () => boolean;
  /** Clear session so next message starts a fresh conversation. */
  resetSession: () => void;
  /** Stop any running container for this group (used before resetSession
   * to prevent a late setSession from the old container undoing the reset). */
  closeActiveContainer: () => void;
  /** Get formatted usage report from persisted usage data. */
  getUsageReport: () => string;
  /** Check for package updates, rebuild if needed. Returns report string and whether rebuild happened. */
  autoUpdate: () => Promise<{ report: string; rebuilt: boolean }>;
  /** Get current resolved reasoning effort for this group. */
  getEffort: () => string;
  /** Set effort override for this group (null = remove override, use default). Throws on failure. */
  setEffort: (level: string | null) => void;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

function isSyntheticAutoCompactCommand(
  msg: NewMessage,
  command: string | null,
): boolean {
  return (
    command === '/compact' &&
    msg.sender === 'system' &&
    msg.id.startsWith('autocompact-')
  );
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  groupFolder?: string;
  triggerPattern: RegExp;
  timezone: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  const isAutoCompactCommand = isSyntheticAutoCompactCommand(cmdMsg, command);

  if (!isSessionCommandAllowed(isMainGroup, !!cmdMsg.is_from_me)) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED
  logger.info({ group: groupName, command }, 'Session command');

  // /usage: host-only — read persisted usage data, no container needed
  if (command === '/usage') {
    const report = deps.getUsageReport();
    await deps.sendMessage(report);
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /thinking: host-only toggle — no container needed
  if (command === '/thinking') {
    const enabled = deps.toggleThinking();
    await deps.sendMessage(`Thinking mode: ${enabled ? 'ON' : 'OFF'}`);
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /new: host-only — clear session. Close any running container first so its
  // trailing setSession doesn't resurrect the old session ID.
  if (command === '/new') {
    deps.closeActiveContainer();
    deps.resetSession();
    await deps.sendMessage('New session started.');
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /auto-update: check for updates, rebuild only if needed
  if (command === '/auto-update') {
    await deps.sendMessage('Checking for updates...');
    try {
      const { report, rebuilt } = await deps.autoUpdate();
      await deps.sendMessage(report);
      if (rebuilt) {
        deps.advanceCursor(cmdMsg.timestamp);
        setTimeout(() => deps.reboot(), 500);
        return { handled: true, success: true };
      }
    } catch (err) {
      await deps.sendMessage(
        `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /dreaming: run memory consolidation
  if (command.startsWith('/dreaming')) {
    const subcommand = command.replace('/dreaming', '').trim() || 'status';
    try {
      const { dreamCycle, lightSleep, deepSleep } =
        await import('./memory/dreaming.js');
      const { resolveGroupFolderPath } = await import('./group-folder.js');
      const gDir = opts.groupFolder
        ? resolveGroupFolderPath(opts.groupFolder)
        : '';

      if (subcommand === 'status') {
        const { loadRecallStore } = await import('./memory/recall-tracker.js');
        const store = loadRecallStore(gDir);
        const entryCount = Object.keys(store.entries).length;
        await deps.sendMessage(
          `Dreaming status:\n` +
            `• Recall entries: ${entryCount}\n` +
            `• Last updated: ${store.lastUpdated || 'never'}\n` +
            `• Group: ${groupName}`,
        );
      } else if (subcommand === 'run') {
        await deps.sendMessage(
          'Running full dream cycle (light → REM → deep)...',
        );
        const result = dreamCycle(gDir);
        await deps.sendMessage(
          `Dream cycle complete:\n` +
            `• Light: ${result.light.candidates} candidates, ${result.light.deduplicated} deduplicated\n` +
            `• REM: ${result.rem.patterns} patterns found\n` +
            `• Deep: ${result.deep.promoted} promoted, ${result.deep.rejected} rejected`,
        );
      } else if (subcommand === 'light') {
        const result = lightSleep(gDir);
        await deps.sendMessage(
          `Light sleep: ${result.candidates} candidates, ${result.deduplicated} deduplicated`,
        );
      } else if (subcommand === 'deep') {
        const result = deepSleep(gDir);
        await deps.sendMessage(
          `Deep sleep: ${result.promoted} promoted, ${result.rejected} rejected`,
        );
      } else {
        await deps.sendMessage('Usage: /dreaming [status|run|light|deep]');
      }
    } catch (err) {
      await deps.sendMessage(
        `Dreaming error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /effort: host-only — show or set reasoning effort for this group.
  // Setting a new value closes the active container so the next message picks up the change.
  if (command === '/effort' || command.startsWith('/effort ')) {
    const arg = command.slice('/effort'.length).trim().toLowerCase();

    if (!arg) {
      await deps.sendMessage(
        `Effort: ${deps.getEffort()}\nUsage: /effort low|medium|high|max|reset`,
      );
      deps.advanceCursor(cmdMsg.timestamp);
      return { handled: true, success: true };
    }

    const isReset = arg === 'reset' || arg === 'default';
    const VALID = ['low', 'medium', 'high', 'max'];
    if (!isReset && !VALID.includes(arg)) {
      await deps.sendMessage(
        `Invalid effort "${arg}". Valid: low, medium, high, max, reset.`,
      );
      deps.advanceCursor(cmdMsg.timestamp);
      return { handled: true, success: true };
    }

    try {
      deps.setEffort(isReset ? null : arg);
    } catch (err) {
      await deps.sendMessage(
        `Failed to set effort: ${err instanceof Error ? err.message : String(err)}`,
      );
      deps.advanceCursor(cmdMsg.timestamp);
      return { handled: true, success: true };
    }

    deps.closeActiveContainer();
    await deps.sendMessage(
      isReset
        ? `Effort reset to default (${deps.getEffort()}). Container restarted.`
        : `Effort set to ${arg}. Container restarted.`,
    );
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // /restart: host-only command — no container needed
  if (command === '/restart') {
    await deps.sendMessage('Rebooting...');
    deps.advanceCursor(cmdMsg.timestamp);
    // Small delay so the message is delivered before process exits
    setTimeout(() => deps.reboot(), 500);
    return { handled: true, success: true };
  }

  // Process pre-command messages first, then run the command

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName, autoCompact: isAutoCompactCommand },
        'Pre-compact processing failed, aborting session command',
      );
      if (!isAutoCompactCommand) {
        await deps.sendMessage(
          `Failed to process messages before ${command}. Try again.`,
        );
      }
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text && !isAutoCompactCommand) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    if (isAutoCompactCommand) {
      logger.warn({ group: groupName, command }, 'Auto-compact failed');
    } else {
      await deps.sendMessage(`${command} failed. The session is unchanged.`);
    }
  }

  return { handled: true, success: true };
}
