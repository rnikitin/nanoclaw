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
  if (text === '/compact') return '/compact';
  if (text === '/usage') return '/usage';
  if (text === '/restart') return '/restart';
  if (text === '/thinking') return '/thinking';
  if (text === '/new') return '/new';
  if (text === '/auto-update') return '/auto-update';
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
  /** Get formatted usage report from persisted usage data. */
  getUsageReport: () => string;
  /** Check for package updates, rebuild if needed. Returns report string and whether rebuild happened. */
  autoUpdate: () => Promise<{ report: string; rebuilt: boolean }>;
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
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

  // /new: host-only — clear session, no container needed
  if (command === '/new') {
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
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
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
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
