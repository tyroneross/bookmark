import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomic-write.js';
import { getSessionDir } from '../handoff/paths.js';
import type { BookmarkState, SessionEntry } from '../types.js';

const STATE_VERSION = '1.0.0';
const MAX_SESSION_HISTORY = 10;

function defaultState(): BookmarkState {
  return {
    version: STATE_VERSION,
    session_id: '',
    compaction_count: 0,
    current_threshold: 0.20,
    last_snapshot_time: 0,
    last_event_time: 0,
    snapshot_interval_minutes: 5,
    session_history: [],
  };
}

export function getStatePath(storagePath: string): string {
  return join(storagePath, 'state.json');
}

export function loadState(storagePath: string): BookmarkState {
  const statePath = getStatePath(storagePath);
  if (!existsSync(statePath)) {
    return defaultState();
  }
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as BookmarkState;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

export function saveState(storagePath: string, state: BookmarkState): void {
  writeFileAtomic(getStatePath(storagePath), JSON.stringify(state, null, 2));
}

/**
 * Per-session state lives at `<storage>/sessions/<sid>/state.json` so
 * concurrent sessions in one repo never share threshold dedupe or counters.
 * Without a session id, callers fall back to the legacy repo-level file.
 * A new session seeds only configuration (the snapshot interval) from the
 * legacy repo-level state, which is read but never written here.
 */
export function loadSessionState(storagePath: string, sessionId?: string): BookmarkState {
  if (!sessionId) return loadState(storagePath);
  const sessionDir = getSessionDir(storagePath, sessionId);
  if (existsSync(getStatePath(sessionDir))) return loadState(sessionDir);
  const legacy = loadState(storagePath);
  return {
    ...defaultState(),
    session_id: sessionId,
    snapshot_interval_minutes: legacy.snapshot_interval_minutes,
  };
}

export function saveSessionState(storagePath: string, sessionId: string | undefined, state: BookmarkState): void {
  if (!sessionId) {
    saveState(storagePath, state);
    return;
  }
  saveState(getSessionDir(storagePath, sessionId), state);
}

/** Most recently written session state, else the legacy repo-level state (for status views). */
export function loadLatestSessionState(storagePath: string): BookmarkState {
  const sessionsDir = join(storagePath, 'sessions');
  let newest: { dir: string; mtime: number } | null = null;
  try {
    for (const name of readdirSync(sessionsDir)) {
      const statePath = join(sessionsDir, name, 'state.json');
      try {
        const mtime = statSync(statePath).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { dir: join(sessionsDir, name), mtime };
      } catch { /* session without state */ }
    }
  } catch { /* no sessions dir */ }
  return newest ? loadState(newest.dir) : loadState(storagePath);
}

export function incrementCompaction(state: BookmarkState, thresholds: number[]): BookmarkState {
  const newCount = state.compaction_count + 1;
  const thresholdIndex = Math.min(newCount, thresholds.length - 1);
  return {
    ...state,
    compaction_count: newCount,
    current_threshold: thresholds[thresholdIndex],
    // The first prompt after compaction can still see the final pre-compaction
    // usage record. Keep handled thresholds until a lower usage record proves
    // the new context cycle is active.
    token_thresholds_triggered: state.token_thresholds_triggered,
  };
}

export function resetForNewSession(state: BookmarkState, sessionId: string, thresholds: number[]): BookmarkState {
  // Archive current session if it has data
  const history = [...state.session_history];
  if (state.session_id) {
    const currentEntry: SessionEntry = {
      session_id: state.session_id,
      started: state.session_history.find(s => s.session_id === state.session_id)?.started ?? state.last_event_time,
      ended: Date.now(),
      compaction_count: state.compaction_count,
      snapshots_taken: 0, // Incremented by incrementSnapshotCount on each capture
    };
    history.unshift(currentEntry);
    if (history.length > MAX_SESSION_HISTORY) {
      history.length = MAX_SESSION_HISTORY;
    }
  }

  return {
    ...state,
    session_id: sessionId,
    compaction_count: 0,
    current_threshold: thresholds[0],
    last_event_time: Date.now(),
    session_history: history,
    token_thresholds_triggered: [],
    latest_model: undefined,
    latest_context_tokens: undefined,
    latest_context_limit_tokens: undefined,
    latest_context_used_pct: undefined,
    latest_context_observed_at: undefined,
    unknown_context_limit_notified_model: undefined,
  };
}

export function updateSnapshotTime(state: BookmarkState): BookmarkState {
  return {
    ...state,
    last_snapshot_time: Date.now(),
    last_event_time: Date.now(),
  };
}

/**
 * Increment snapshots_taken for the current session in session_history.
 * Previously this was never called — snapshots_taken was always 0.
 */
export function incrementSnapshotCount(state: BookmarkState): BookmarkState {
  if (!state.session_id) return state;

  const history = state.session_history.map(entry => {
    if (entry.session_id === state.session_id) {
      return { ...entry, snapshots_taken: entry.snapshots_taken + 1 };
    }
    return entry;
  });

  return { ...state, session_history: history };
}
