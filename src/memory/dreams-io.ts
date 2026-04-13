import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';

import { ensureDir } from '../fs-utils.js';

/**
 * Ensure `.dreams/` exists under the given group dir, mode 0o777 so the
 * container (different UID) can also write into it.
 */
export function ensureDreamsDir(groupDir: string): string {
  const dreamsDir = join(groupDir, '.dreams');
  ensureDir(dreamsDir, 0o777);
  return dreamsDir;
}

/**
 * Write a JSON payload into a dreams file with mode 0o666 (same rationale
 * as the dir — the container and host both write this store).
 */
export function writeDreamsJson(
  filePath: string,
  data: unknown,
  indent = 2,
): void {
  writeFileSync(filePath, JSON.stringify(data, null, indent));
  try {
    chmodSync(filePath, 0o666);
  } catch {
    /* ignore — chmod not critical */
  }
}
