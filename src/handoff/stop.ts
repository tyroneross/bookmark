import { existsSync } from 'node:fs';
import { isContextMdFresh, passesHandoffChecks } from '../context/freshness.js';
import { writeFileAtomic } from '../util/atomic-write.js';
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
      why: 'disabled' | 'easy_terminal_owns_pane' | 'fresh_handoff' | 'sealed_recently' | 'already_blocked';
      record?: LineageRecord;
    }
  | { decision: 'block'; handoffPath: string };

/**
 * A6: seal any changed handoff, then approve when the handoff is fresh or its
 * seal is under 10 minutes old at the same HEAD. Otherwise block at most once
 * per session, tracked by the per-session stop-requested marker. A7/C7: no
 * block when handoff is off or Easy Terminal owns this pane.
 */
export function decideStop(
  context: SessionHandoffContext & { enabled: boolean; easyTerminalDriving?: boolean }
): StopDecision {
  let record: LineageRecord | null = null;
  try {
    record = sealIfChanged(context);
  } catch { /* sealing is best-effort; the decision below still holds */ }

  if (!context.enabled) return { decision: 'approve', why: 'disabled' };
  if (context.easyTerminalDriving) return { decision: 'approve', why: 'easy_terminal_owns_pane' };

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
