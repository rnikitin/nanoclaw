import fs from 'fs';
import path from 'path';

import { ensureDir } from './fs-utils.js';

/**
 * Atomic JSON write into an IPC directory. Ext4 guarantees `rename`
 * is atomic, so readers never see a partially-written payload.
 * Returns absolute path on success, null on failure.
 */
export function writeIpcJsonAtomic(
  dir: string,
  payload: unknown,
): string | null {
  try {
    ensureDir(dir);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(dir, filename);
    const tmp = `${filepath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, filepath);
    return filepath;
  } catch {
    return null;
  }
}
