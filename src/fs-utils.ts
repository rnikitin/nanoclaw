import fs from 'fs';

/**
 * Recursively create a directory. No-op if it already exists.
 * Pass `mode` to set permissions on newly created segments.
 */
export function ensureDir(p: string, mode?: number): void {
  fs.mkdirSync(p, { recursive: true, ...(mode !== undefined && { mode }) });
}
