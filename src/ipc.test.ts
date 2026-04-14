import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { _initTestDatabase } from './db.js';
import { startIpcWatcher, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function writeIpcFile(
  dataDir: string,
  group: string,
  subdir: 'messages' | 'tasks' | 'canvas',
  name: string,
  payload: unknown,
): void {
  const dir = join(dataDir, 'ipc', group, subdir);
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload));
  require('fs').renameSync(tmpPath, finalPath);
}

describe('IPC watcher', () => {
  let dataDir: string;
  let stop: (() => void) | null = null;
  let sentMessages: Array<{ jid: string; text: string }>;
  let groups: Record<string, RegisteredGroup>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    dataDir = mkdtempSync(join(tmpdir(), 'nanoclaw-ipc-test-'));
    sentMessages = [];
    groups = {
      'main@g.us': {
        name: 'Main',
        folder: 'mainfolder',
        trigger: 'always',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
      'peer@g.us': {
        name: 'Peer',
        folder: 'peerfolder',
        trigger: '@Ark',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    };
    deps = {
      sendMessage: async (jid, text) => {
        sentMessages.push({ jid, text });
      },
      sendFile: async () => {},
      registeredGroups: () => groups,
      registerGroup: (jid, group) => {
        groups[jid] = group;
      },
      syncGroups: async () => {},
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
  });

  afterEach(() => {
    stop?.();
    stop = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('delivers IPC message dropped into an existing group dir', async () => {
    mkdirSync(join(dataDir, 'ipc', 'mainfolder', 'messages'), {
      recursive: true,
    });
    stop = startIpcWatcher(deps, { dataDir });

    writeIpcFile(dataDir, 'mainfolder', 'messages', 'msg1.json', {
      type: 'message',
      chatJid: 'peer@g.us',
      text: 'hello from main',
    });

    await waitUntil(() => sentMessages.length >= 1);
    expect(sentMessages).toEqual([
      { jid: 'peer@g.us', text: 'hello from main' },
    ]);

    const remaining = readdirSync(
      join(dataDir, 'ipc', 'mainfolder', 'messages'),
    );
    expect(remaining).toHaveLength(0);
  });

  it('picks up a group directory created after startup (base watcher)', async () => {
    mkdirSync(join(dataDir, 'ipc'), { recursive: true });
    stop = startIpcWatcher(deps, { dataDir });

    writeIpcFile(dataDir, 'mainfolder', 'messages', 'msg1.json', {
      type: 'message',
      chatJid: 'peer@g.us',
      text: 'late group',
    });

    await waitUntil(() => sentMessages.length >= 1, 2000);
    expect(sentMessages[0].text).toBe('late group');
  });

  it('coalesces rapid writes into a bounded number of drain cycles', async () => {
    mkdirSync(join(dataDir, 'ipc', 'mainfolder', 'messages'), {
      recursive: true,
    });
    stop = startIpcWatcher(deps, { dataDir });

    for (let i = 0; i < 5; i++) {
      writeIpcFile(dataDir, 'mainfolder', 'messages', `msg${i}.json`, {
        type: 'message',
        chatJid: 'peer@g.us',
        text: `rapid ${i}`,
      });
    }

    await waitUntil(() => sentMessages.length >= 5, 2000);
    expect(sentMessages).toHaveLength(5);
    const remaining = readdirSync(
      join(dataDir, 'ipc', 'mainfolder', 'messages'),
    );
    expect(remaining).toHaveLength(0);
  });

  it('non-main group only delivers messages targeting its own chats', async () => {
    mkdirSync(join(dataDir, 'ipc', 'peerfolder', 'messages'), {
      recursive: true,
    });
    stop = startIpcWatcher(deps, { dataDir });

    // Non-main group trying to message another group's jid — should be dropped
    writeIpcFile(dataDir, 'peerfolder', 'messages', 'msg1.json', {
      type: 'message',
      chatJid: 'main@g.us',
      text: 'unauthorized cross-group',
    });
    // Non-main group messaging itself — should deliver
    writeIpcFile(dataDir, 'peerfolder', 'messages', 'msg2.json', {
      type: 'message',
      chatJid: 'peer@g.us',
      text: 'own chat',
    });

    await waitUntil(() => {
      const files = readdirSync(join(dataDir, 'ipc', 'peerfolder', 'messages'));
      return files.length === 0;
    }, 2000);

    expect(sentMessages).toEqual([{ jid: 'peer@g.us', text: 'own chat' }]);
  });

  it('stop() closes watchers and halts subsequent drains', async () => {
    mkdirSync(join(dataDir, 'ipc', 'mainfolder', 'messages'), {
      recursive: true,
    });
    stop = startIpcWatcher(deps, { dataDir });

    writeIpcFile(dataDir, 'mainfolder', 'messages', 'msg1.json', {
      type: 'message',
      chatJid: 'peer@g.us',
      text: 'first',
    });
    await waitUntil(() => sentMessages.length >= 1);

    stop();
    stop = null;

    writeIpcFile(dataDir, 'mainfolder', 'messages', 'msg2.json', {
      type: 'message',
      chatJid: 'peer@g.us',
      text: 'after stop',
    });

    // Give the watcher a chance to (wrongly) fire
    await new Promise((r) => setTimeout(r, 100));
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toBe('first');
  });
});
