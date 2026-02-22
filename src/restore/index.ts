import { existsSync } from 'node:fs';
import { readLatestMd, loadLatestSnapshot, getSnapshotCount } from '../snapshot/storage.js';
import { loadState, saveState, resetForNewSession, incrementCompaction } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import type { HookOutput, BookmarkState } from '../types.js';

export interface RestoreOptions {
  source?: 'startup' | 'resume' | 'compact' | 'clear';
  sessionId?: string;
  cwd: string;
  format?: 'system_message' | 'json' | 'markdown';
}

/**
 * Generate restoration context for a SessionStart hook.
 * Returns a HookOutput with systemMessage containing the LATEST.md content.
 */
export function restoreContext(options: RestoreOptions): HookOutput {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadState(storagePath);

  // Handle session state transitions
  handleSessionTransition(storagePath, state, options, config.thresholds);

  // Check if restoration is needed
  if (!config.restoreOnSessionStart) {
    return {};
  }

  // On resume, context is likely intact — skip restoration
  if (options.source === 'resume') {
    return {};
  }

  // Check for existing snapshots
  const snapshotCount = getSnapshotCount(storagePath);
  if (snapshotCount === 0) {
    // First run — tell Claude that bookmark is active
    return {
      systemMessage:
        'Bookmark (context snapshots) is active for this project. ' +
        'Snapshots will be captured automatically before compaction, ' +
        'on 20-minute intervals, and at session end. ' +
        'Use /bookmark:status to check inventory.',
    };
  }

  // Read LATEST.md
  const latestMd = readLatestMd(storagePath);
  if (!latestMd) {
    return {};
  }

  if (options.format === 'json') {
    const snapshot = loadLatestSnapshot(storagePath);
    return {
      systemMessage: JSON.stringify(snapshot, null, 2),
    };
  }

  if (options.format === 'markdown') {
    return {
      systemMessage: latestMd,
    };
  }

  // Default: system_message format
  const systemMessage = buildRestorationMessage(latestMd, snapshotCount);
  return { systemMessage };
}

function buildRestorationMessage(latestMd: string, snapshotCount: number): string {
  const lines: string[] = [];
  lines.push('## Prior Session Context (Bookmark)');
  lines.push('');
  lines.push(latestMd);
  lines.push('');
  if (snapshotCount > 1) {
    lines.push(`> ${snapshotCount} snapshots available. Use \`/bookmark:list\` for history or \`/bookmark:restore\` for a specific snapshot.`);
  }
  return lines.join('\n');
}

function handleSessionTransition(
  storagePath: string,
  state: BookmarkState,
  options: RestoreOptions,
  thresholds: number[]
): void {
  const source = options.source ?? 'startup';
  const sessionId = options.sessionId ?? `session_${Date.now()}`;

  let updatedState: BookmarkState;

  switch (source) {
    case 'startup':
    case 'clear':
      // New session — reset compaction count
      updatedState = resetForNewSession(state, sessionId, thresholds);
      break;

    case 'compact':
      // After compaction — increment compaction count
      updatedState = incrementCompaction(state, thresholds);
      updatedState.session_id = sessionId;
      break;

    case 'resume':
      // Resuming — keep state, just update session ID if different
      updatedState = { ...state, session_id: sessionId, last_event_time: Date.now() };
      break;

    default:
      updatedState = state;
  }

  if (!existsSync(storagePath)) return;
  saveState(storagePath, updatedState);
}
