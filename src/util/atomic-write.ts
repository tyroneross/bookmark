import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file so readers never observe a partial or interleaved write:
 * the bytes go to a uniquely named temp file in the same directory, then
 * renameSync swaps it into place (atomic on the same filesystem).
 */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, data, typeof data === 'string' ? 'utf-8' : undefined);
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* temp may not exist */ }
    throw err;
  }
}
