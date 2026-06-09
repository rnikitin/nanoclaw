import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempHomes: string[] = [];

async function loadGroupModels(home: string) {
  vi.resetModules();
  vi.doMock('os', () => ({
    default: { homedir: () => home },
    homedir: () => home,
  }));
  return import('./group-models.js');
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-models-'));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  vi.doUnmock('os');
  vi.resetModules();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('resolveGroupModel', () => {
  it('uses Opus 4.8 as the built-in primary and opus tier model', async () => {
    const { resolveGroupModel } = await loadGroupModels(makeHome());

    const resolved = resolveGroupModel('missing-group');

    expect(resolved.primaryModel).toBe('claude-opus-4-8');
    expect(resolved.tiers.opus).toBe('claude-opus-4-8');
  });

  it('maps legacy xhigh effort to high', async () => {
    const home = makeHome();
    const configDir = path.join(home, '.config', 'nanoclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'group-models.json'),
      JSON.stringify({
        defaults: { effort: 'medium' },
        groups: {
          main: { effort: 'xhigh' },
        },
      }),
    );
    const { resolveGroupModel } = await loadGroupModels(home);

    expect(resolveGroupModel('main').effort).toBe('high');
  });
});
