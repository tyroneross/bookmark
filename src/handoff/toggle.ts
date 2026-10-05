import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BookmarkConfig } from '../types.js';
import { easyTerminalStateDir, paneFileName } from './paths.js';

/** C8 freshness window for ET's reset marker. */
export const ET_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

/** C7': ET rewrites its driving file every 10 s; older than this means ET is not driving. */
export const ET_DRIVING_MAX_AGE_MS = 60 * 1000;

/**
 * C1': `<state dir>/settings/context-handoff.json`, key `enabled`. Absent key or
 * missing file = on. Unreadable or malformed file = on (bookmark never writes it).
 */
export function readEasyTerminalToggle(env: NodeJS.ProcessEnv = process.env): boolean {
  const stateDir = easyTerminalStateDir(env);
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'settings', 'context-handoff.json'), 'utf-8'));
    return !(parsed && typeof parsed === 'object' && parsed.enabled === false);
  } catch {
    return true;
  }
}

/**
 * Handoff prompts (threshold prompt + Stop block) are on unless any switch
 * turns them off: the Easy Terminal setting, `BOOKMARK_HANDOFF=off`, or
 * `handoff.enabled: false` in `.bookmark/config.json`. Snapshots are unaffected.
 */
export function isHandoffEnabled(
  config?: Pick<BookmarkConfig, 'handoff'>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const envValue = env.BOOKMARK_HANDOFF?.trim().toLowerCase();
  if (envValue && ['off', '0', 'false', 'no', 'disabled'].includes(envValue)) return false;
  if (config?.handoff?.enabled === false) return false;
  return readEasyTerminalToggle(env);
}

/**
 * C7': Easy Terminal owns this pane's handoff when
 * `<state dir>/context-handoff/driving/<pane>.json` was written within 60 s and
 * the toggle is on. Bookmark then sends no threshold prompt and no Stop block
 * (snapshots continue).
 */
export function isEasyTerminalDriving(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): boolean {
  const pane = env.EASY_TERMINAL_PANE_ID?.trim();
  const fileName = pane ? paneFileName(pane) : null;
  if (!fileName) return false;
  try {
    const path = join(easyTerminalStateDir(env), 'context-handoff', 'driving', `${fileName}.json`);
    if (now - statSync(path).mtimeMs > ET_DRIVING_MAX_AGE_MS) return false;
  } catch {
    return false;
  }
  return readEasyTerminalToggle(env);
}
