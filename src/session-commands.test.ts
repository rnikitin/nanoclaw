import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import type { NewMessage } from './types.js';
import type { SessionCommandDeps } from './session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toBe('/compact');
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toBe('/compact');
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toBe('/compact');
  });

  it('is case-sensitive for the command', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
  });

  it('detects /restart', () => {
    expect(extractSessionCommand('/restart', trigger)).toBe('/restart');
  });

  it('detects /restart with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /restart', trigger)).toBe('/restart');
  });

  it('detects /thinking', () => {
    expect(extractSessionCommand('/thinking', trigger)).toBe('/thinking');
  });

  it('detects /thinking with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /thinking', trigger)).toBe('/thinking');
  });

  it('detects /new', () => {
    expect(extractSessionCommand('/new', trigger)).toBe('/new');
  });

  it('detects /new with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /new', trigger)).toBe('/new');
  });

  it('detects /auto-update', () => {
    expect(extractSessionCommand('/auto-update', trigger)).toBe('/auto-update');
  });

  it('detects /auto-update with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /auto-update', trigger)).toBe(
      '/auto-update',
    );
  });

  it('strips Telegram bot suffix from commands', () => {
    expect(extractSessionCommand('/usage@mybot', trigger)).toBe('/usage');
    expect(extractSessionCommand('/compact@ArkBot', trigger)).toBe('/compact');
    expect(extractSessionCommand('/restart@some_bot', trigger)).toBe(
      '/restart',
    );
    expect(extractSessionCommand('@Andy /thinking@mybot', trigger)).toBe(
      '/thinking',
    );
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows main group regardless of sender', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows trusted/admin sender (is_from_me) in non-main group', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies untrusted sender in non-main group', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });

  it('allows trusted sender in main group', () => {
    expect(isSessionCommandAllowed(true, true)).toBe(true);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    canSenderInteract: vi.fn().mockReturnValue(true),
    reboot: vi.fn(),
    autoUpdate: vi.fn().mockResolvedValue({
      report: 'All packages up to date.\n\nclaude-code: 1.0 ✓',
      rebuilt: false,
    }),
    toggleThinking: vi.fn().mockReturnValue(true),
    resetSession: vi.fn(),
    closeActiveContainer: vi.fn(),
    getUsageReport: vi.fn().mockReturnValue('No usage data yet.'),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('sends denial to interactable sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    // Two runAgent calls: pre-compact + /compact
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('allows is_from_me sender in non-main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      isMainGroup: false,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
  });

  it('reports failure when command-stage runAgent returns error without streamed status', async () => {
    // runAgent resolves 'error' but callback never gets status: 'error'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        await onOutput({ status: 'success', result: null });
        return 'error';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
    );
  });

  it('handles /restart without spawning container', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/restart')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Rebooting...');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.runAgent).not.toHaveBeenCalled();
    // reboot is called after setTimeout
    vi.advanceTimersByTime(500);
    expect(deps.reboot).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('handles /thinking toggle without spawning container', async () => {
    const deps = makeDeps({ toggleThinking: vi.fn().mockReturnValue(true) });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.toggleThinking).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('Thinking mode: ON');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('/thinking toggle OFF', async () => {
    const deps = makeDeps({ toggleThinking: vi.fn().mockReturnValue(false) });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('Thinking mode: OFF');
  });

  it('handles /new without spawning container', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.closeActiveContainer).toHaveBeenCalled();
    expect(deps.resetSession).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('New session started.');
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles /auto-update with no updates needed', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/auto-update')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.autoUpdate).toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('Checking for updates...');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('up to date'),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith('100');
    expect(deps.reboot).not.toHaveBeenCalled();
  });

  it('handles /auto-update with updates — rebuilds and reboots', async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      autoUpdate: vi.fn().mockResolvedValue({
        report: 'Updates found, container rebuilt.\n\nclaude-code: 1.0 → 1.1 ⬆',
        rebuilt: true,
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/auto-update')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('rebuilt'),
    );
    vi.advanceTimersByTime(500);
    expect(deps.reboot).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('handles /auto-update failure gracefully', async () => {
    const deps = makeDeps({
      autoUpdate: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/auto-update')],
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Update check failed: network error',
    );
    expect(deps.reboot).not.toHaveBeenCalled();
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      isMainGroup: true,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });
});
