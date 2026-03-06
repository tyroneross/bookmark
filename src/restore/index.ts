import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readLatestMd, getSnapshotCount } from '../snapshot/storage.js';
import { readContextMd } from '../trails/reader.js';
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
 *
 * Simplified cascade (v0.3.1):
 * 1. bookmark.context.md — Claude-written session summary (primary)
 * 2. LATEST.md — File tracking data (fallback)
 * 3. Empty — First run, nothing to restore
 */
export function restoreContext(options: RestoreOptions): HookOutput {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadState(storagePath);

  // Handle session state transitions
  handleSessionTransition(storagePath, state, options, config.thresholds);

  // Clean up .stop-requested state file from previous sessions
  const stopRequestedPath = join(storagePath, '.stop-requested');
  if (existsSync(stopRequestedPath)) {
    try { unlinkSync(stopRequestedPath); } catch { /* ignore */ }
  }

  // Check if restoration is needed
  if (!config.restoreOnSessionStart) {
    return {};
  }

  // On resume, context is likely intact — skip restoration
  if (options.source === 'resume') {
    return {};
  }

  // Primary: bookmark.context.md (Claude-written session summary) — with quality gate
  const contextMd = readContextMd(storagePath);
  if (contextMd && isContextMdUseful(contextMd)) {
    // Add staleness warning if >24h old
    const contextPath = join(storagePath, 'bookmark.context.md');
    const ageWarning = getStalenessWarning(contextPath);
    const message = ageWarning ? `${ageWarning}\n\n${contextMd}` : contextMd;
    trackRestore(storagePath, message.length);
    return { systemMessage: message };
  }

  // bookmark.context.md existed but failed quality — track it
  if (contextMd) {
    trackBoilerplateCaught(storagePath);
  }

  // Fallback: LATEST.md (file tracking data)
  const snapshotCount = getSnapshotCount(storagePath);
  const latestMd = readLatestMd(storagePath);
  if (latestMd) {
    const message = buildFallbackRestoration(latestMd, snapshotCount);
    trackRestore(storagePath, message.length);
    return { systemMessage: message };
  }

  return {};
}

/** Record a successful restore — chars injected / 4 ≈ tokens */
function trackRestore(storagePath: string, charCount: number): void {
  try {
    const state = loadState(storagePath);
    state.restores_performed = (state.restores_performed ?? 0) + 1;
    state.tokens_injected = (state.tokens_injected ?? 0) + Math.round(charCount / 4);
    saveState(storagePath, state);
  } catch { /* never break restore for tracking */ }
}

/** Record a boilerplate bookmark.context.md that was skipped */
function trackBoilerplateCaught(storagePath: string): void {
  try {
    const state = loadState(storagePath);
    state.boilerplate_caught = (state.boilerplate_caught ?? 0) + 1;
    saveState(storagePath, state);
  } catch { /* never break restore for tracking */ }
}

/**
 * Quality gate for bookmark.context.md content — skip boilerplate that wastes tokens.
 * Real summaries are >200 bytes and contain markdown structure.
 */
function isContextMdUseful(content: string): boolean {
  // Size gate: boilerplate templates are ~180 bytes
  if (content.length < 200) return false;
  // Boilerplate detection: old auto-generated summaries start with [Bookmark Context
  // and lack real markdown headers
  if (content.startsWith('[Bookmark Context') && !content.includes('## ')) return false;
  // Must have at least one real content marker
  const markers = ['## ', '**Task', '**Status', '**Progress', 'done', 'remaining', '- '];
  return markers.some(m => content.includes(m));
}

/**
 * If bookmark.context.md is >24h old, return a staleness warning prefix.
 * Prevents stale context from being treated as current.
 */
function getStalenessWarning(contextPath: string): string | null {
  try {
    const mtime = statSync(contextPath).mtimeMs;
    const ageMs = Date.now() - mtime;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    if (ageHours >= 24) {
      return `[Note: This bookmark context is ${ageHours}h old and may be outdated.]`;
    }
    return null;
  } catch {
    return null;
  }
}

function buildFallbackRestoration(latestMd: string, snapshotCount: number): string {
  const lines: string[] = [];
  lines.push('[Bookmark: Context recovered from previous session]');
  lines.push('');
  lines.push(latestMd);
  if (snapshotCount > 1) {
    lines.push('');
    lines.push(`> ${snapshotCount} snapshots available. \`/bookmark:list\` for history.`);
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
