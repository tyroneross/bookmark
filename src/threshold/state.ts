import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    snapshot_interval_minutes: 20,
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
  const statePath = getStatePath(storagePath);
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function incrementCompaction(state: BookmarkState, thresholds: number[]): BookmarkState {
  const newCount = state.compaction_count + 1;
  const thresholdIndex = Math.min(newCount, thresholds.length - 1);
  return {
    ...state,
    compaction_count: newCount,
    current_threshold: thresholds[thresholdIndex],
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
      snapshots_taken: 0, // Updated elsewhere
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
  };
}

export function updateSnapshotTime(state: BookmarkState): BookmarkState {
  return {
    ...state,
    last_snapshot_time: Date.now(),
    last_event_time: Date.now(),
  };
}
