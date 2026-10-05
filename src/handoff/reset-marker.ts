import { readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { easyTerminalStateDir, paneFileName } from './paths.js';
import { ET_MARKER_MAX_AGE_MS } from './toggle.js';

export interface ResetMarker {
  markerPath: string;
  path: string;
  sha256: string;
  writtenAt?: string;
  provider?: string;
}

/**
 * C8: Easy Terminal writes `<state dir>/context-handoff/resets/<pane>.json`
 * just before it sends the reset command. A marker older than 10 minutes, or
 * one without a string `path` and `sha256`, is ignored.
 */
export function readResetMarker(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): ResetMarker | null {
  const pane = env.EASY_TERMINAL_PANE_ID?.trim();
  const fileName = pane ? paneFileName(pane) : null;
  if (!fileName) return null;
  const markerPath = join(easyTerminalStateDir(env), 'context-handoff', 'resets', `${fileName}.json`);
  try {
    if (now - statSync(markerPath).mtimeMs > ET_MARKER_MAX_AGE_MS) return null;
    const parsed = JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
    if (typeof parsed.path !== 'string' || !parsed.path || typeof parsed.sha256 !== 'string' || !parsed.sha256) {
      return null;
    }
    return {
      markerPath,
      path: parsed.path,
      sha256: parsed.sha256.trim().toLowerCase(),
      writtenAt: typeof parsed.written_at === 'string' ? parsed.written_at : undefined,
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
    };
  } catch {
    return null;
  }
}

/** Rename the marker to `<marker file>.consumed` so it is used once; failures are ignored. */
export function consumeResetMarker(marker: ResetMarker): void {
  try {
    renameSync(marker.markerPath, `${marker.markerPath}.consumed`);
  } catch { /* another session consumed it, or the dir is read-only */ }
}
