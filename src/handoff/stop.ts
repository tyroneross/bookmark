import { existsSync } from 'node:fs';
import { isContextMdFresh, passesHandoffChecks } from '../context/freshness.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import type { StopMode } from '../types.js';
import {
  getSessionHandoffPath,
  getSessionStopMarkerPath,
  lineageKey,
} from './paths.js';
import {
  currentGitHead,
  readLineage,
  sealHandoff,
  sha256File,
  type LineageRecord,
} from './lineage.js';

/** A sealed handoff younger than this, at the same HEAD, lets Stop approve without blocking. */
export const SEALED_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;

/** Default usage fraction at which Stop may block; matches the default token threshold. */
export const DEFAULT_STOP_THRESHOLD = 0.75;

export interface SessionHandoffContext {
  storagePath: string;
  cwd: string;
  sessionId: string;
  paneId?: string;
  /** CLAUDE_PID; part of the C2' lineage key. */
  pid?: string;
  /** Injected for tests; defaults to `git rev-parse HEAD` in cwd. */
  head?: string | null;
  now?: number;
}

function keyFor(context: SessionHandoffContext): string {
  return lineageKey({ paneId: context.paneId, pid: context.pid, sessionId: context.sessionId })!;
}

/**
 * Seal this session's handoff whenever it passes the content checks and its
 * bytes differ from what this session's lineage pointer names (no age
 * requirement). Returns this session's current record, or null.
 */
export function sealIfChanged(context: SessionHandoffContext): LineageRecord | null {
  const handoffPath = getSessionHandoffPath(context.storagePath, context.sessionId);
  const existing = readLineage(context.storagePath, keyFor(context));
  const own = existing?.session_id === context.sessionId && existing.handoff_path === handoffPath ? existing : null;

  if (!passesHandoffChecks(handoffPath)) return own;
  if (own && own.sha256 === sha256File(handoffPath)) return own;
  return sealHandoff({
    storagePath: context.storagePath,
    cwd: context.cwd,
    sessionId: context.sessionId,
    paneId: context.paneId,
    pid: context.pid,
    head: context.head,
    now: new Date(context.now ?? Date.now()),
  });
}

export type StopDecision =
  | {
      decision: 'approve';
      why:
        | 'disabled'
        | 'easy_terminal_owns_pane'
        | 'below_threshold'
        | 'fresh_handoff'
        | 'sealed_recently'
        | 'already_blocked';
      record?: LineageRecord;
    }
  | { decision: 'block'; handoffPath: string };

/**
 * Claude Code fires Stop at the end of EVERY assistant turn, not only at
 * session exit. So in `threshold` mode (default) Stop blocks only when the
 * session is at risk of losing context: measured usage at or above
 * `stopThreshold` AND the handoff is neither fresh nor recently sealed.
 * Unmeasured usage (null/undefined) counts as below threshold.
 * `every-turn` mode skips the usage check (pre-0.5.1 behaviour).
 *
 * A6: seal any changed handoff first, then block at most once per session,
 * tracked by the per-session stop-requested marker. A7/C7: no block when
 * handoff is off or Easy Terminal owns this pane.
 */
export function decideStop(
  context: SessionHandoffContext & {
    enabled: boolean;
    easyTerminalDriving?: boolean;
    mode?: StopMode;
    /** Latest measured context usage, 0..1; null/undefined = not measurable. */
    contextUsedFraction?: number | null;
    /** Usage fraction at which Stop may block in threshold mode (default 0.75). */
    stopThreshold?: number;
  }
): StopDecision {
  let record: LineageRecord | null = null;
  try {
    record = sealIfChanged(context);
  } catch { /* sealing is best-effort; the decision below still holds */ }

  if (!context.enabled) return { decision: 'approve', why: 'disabled' };
  if (context.easyTerminalDriving) return { decision: 'approve', why: 'easy_terminal_owns_pane' };

  if ((context.mode ?? 'threshold') === 'threshold') {
    const used = context.contextUsedFraction;
    const threshold = context.stopThreshold ?? DEFAULT_STOP_THRESHOLD;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < threshold) {
      return { decision: 'approve', why: 'below_threshold', record: record ?? undefined };
    }
  }

  const handoffPath = getSessionHandoffPath(context.storagePath, context.sessionId);
  const markerPath = getSessionStopMarkerPath(context.storagePath, context.sessionId);
  const now = context.now ?? Date.now();

  if (isContextMdFresh(handoffPath, markerPath, now)) {
    return { decision: 'approve', why: 'fresh_handoff', record: record ?? undefined };
  }

  if (record?.head) {
    const age = now - Date.parse(record.sealed_at);
    const head = context.head !== undefined ? context.head : currentGitHead(context.cwd);
    if (age >= 0 && age < SEALED_HANDOFF_MAX_AGE_MS && head === record.head) {
      return { decision: 'approve', why: 'sealed_recently', record };
    }
  }

  if (existsSync(markerPath)) return { decision: 'approve', why: 'already_blocked' };

  writeFileAtomic(markerPath, JSON.stringify({ timestamp: now, session_id: context.sessionId }));
  return { decision: 'block', handoffPath };
}
