import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Serialize the complete read/modify/write transaction, not just its rename. */
export function withFileLock<T>(target: string, action: () => T, timeoutMs = 1000): T {
  mkdirSync(dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const deadline = performance.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(lock);
      try { writeFileSync(join(lock, 'owner'), String(process.pid)); }
      catch (error) { rmSync(lock, { recursive: true }); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Only one contender may reap. Other contenders re-read the new owner.
      const reap = `${lock}.reap`;
      try {
        mkdirSync(reap);
        try {
          let dead = false;
          try {
            const pid = Number(readFileSync(join(lock, 'owner'), 'utf8'));
            if (Number.isInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
            }
          } catch { dead = Date.now() - statSync(lock).mtimeMs > 5000; }
          if (dead) rmSync(lock, { recursive: true });
        } finally { rmSync(reap, { recursive: true }); }
      } catch (e) {
        if (!['EEXIST', 'ENOENT'].includes((e as NodeJS.ErrnoException).code || '')) throw e;
      }
      if (performance.now() >= deadline) throw new Error(`Bookmark storage busy: ${target}`);
      Atomics.wait(sleeper, 0, 0, 10);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true }); }
}
