import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Per-session layout (shared contract C2/C3):
 *   <storage>/sessions/<session_id>/{state.json, stop-requested, handoff.md}
 *   <storage>/lineage/<pane:<id>:pid:<pid> | pid:<pid> | session:<id> | legacy>.json
 */

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** Keep ids usable as one path segment; anything else maps to a stable hash. */
export function safeSegment(value: string): string {
  if (SAFE_SEGMENT.test(value) && value !== '.' && value !== '..') return value;
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function getSessionsDir(storagePath: string): string {
  return join(storagePath, 'sessions');
}

export function getSessionDir(storagePath: string, sessionId: string): string {
  return join(getSessionsDir(storagePath), safeSegment(sessionId));
}

export function getSessionHandoffPath(storagePath: string, sessionId: string): string {
  return join(getSessionDir(storagePath, sessionId), 'handoff.md');
}

export function getSessionStopMarkerPath(storagePath: string, sessionId: string): string {
  return join(getSessionDir(storagePath, sessionId), 'stop-requested');
}

export function getLineageDir(storagePath: string): string {
  return join(storagePath, 'lineage');
}

export interface LineageIdentity {
  paneId?: string;
  /** CLAUDE_PID of the agent process; survives /clear, differs for a nested `claude -p`. */
  pid?: string;
  sessionId?: string;
}

/**
 * C2': `pane:<pane>:pid:<pid>` when both are set, `pid:<pid>` when only the
 * pid is set, else `session:<session_id>`. A pane id without a pid is not
 * enough: a nested `claude -p` inherits the pane id but has its own pid.
 */
export function lineageKey(options: LineageIdentity): string | null {
  if (options.pid && options.paneId) return `pane:${options.paneId}:pid:${options.pid}`;
  if (options.pid) return `pid:${options.pid}`;
  if (options.sessionId) return `session:${options.sessionId}`;
  return null;
}

/** Key for a pre-upgrade single-file handoff; never matched by any pane, pid or session. */
export const LEGACY_LINEAGE_KEY = 'legacy';

export function getLineagePath(storagePath: string, key: string): string {
  const name = key.split(':').map(safeSegment).join(':');
  return join(getLineageDir(storagePath), `${name}.json`);
}

/** Pane id from the environment Easy Terminal gives each hosted agent. */
export function currentPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pane = env.EASY_TERMINAL_PANE_ID?.trim();
  return pane ? pane : undefined;
}

/** Claude Code's process id for this agent (CLAUDE_PID). */
export function currentClaudePid(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pid = env.CLAUDE_PID?.trim();
  return pid ? pid : undefined;
}

/** C1': ET_STATE_DIR, else ET_APP_STATE_DIR, else Easy Terminal's default state dir. */
export function easyTerminalStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ET_STATE_DIR?.trim() || env.ET_APP_STATE_DIR?.trim();
  if (override) {
    const expanded = override.startsWith('~/') ? join(homedir(), override.slice(2)) : override;
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  return join(homedir(), 'Library', 'Application Support', 'EasyTerminal');
}

/** Pane ids name files in ET's state dir; refuse anything that is not one plain segment. */
export function paneFileName(paneId: string): string | null {
  return SAFE_SEGMENT.test(paneId) && paneId !== '.' && paneId !== '..' ? paneId : null;
}
