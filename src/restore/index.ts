import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readLatestMd, getSnapshotCount } from '../snapshot/storage.js';
import { readContextMd } from '../trails/reader.js';
import {
  parseIdentity,
  validateRepoIdentity,
  followPointer,
  type BookmarkIdentity,
} from '../trails/identity.js';
import { loadSessionState, saveSessionState, resetForNewSession, incrementCompaction } from '../threshold/state.js';
import { currentClaudePid, currentPaneId, getSessionStopMarkerPath, lineageKey } from '../handoff/paths.js';
import { consumeResetMarker, readResetMarker } from '../handoff/reset-marker.js';
import {
  buildHandoffIndex,
  isGeneratedIndex,
  listLineage,
  readLineage,
  sha256File,
  verifyLine,
  type LineageRecord,
} from '../handoff/lineage.js';
import { loadConfig, getStoragePath } from '../config.js';
import { touchLastProject } from '../registry.js';
import type { HookOutput, BookmarkState } from '../types.js';

export interface RestoreOptions {
  source?: 'startup' | 'resume' | 'compact' | 'clear';
  sessionId?: string;
  /** Easy Terminal pane id; defaults to EASY_TERMINAL_PANE_ID. */
  paneId?: string;
  /** Claude process id; defaults to CLAUDE_PID. */
  pid?: string;
  /** Environment for the ET state dir and reset marker; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  cwd: string;
  format?: 'system_message' | 'json' | 'markdown';
}

/**
 * Hours after which a bookmark is considered too stale to auto-restore.
 * Below this threshold: restore with a soft warning.
 * At or above: hard-block — return an empty context with guidance instead
 * of risking a confident wrong start from stale content.
 */
const STALENESS_HARD_BLOCK_HOURS = 72;
const STALENESS_SOFT_WARN_HOURS = 24;

/**
 * Generate restoration context for a SessionStart hook.
 *
 * v0.4 adds:
 *  1. BOOKMARK_IDENTITY parsing + repo_path validation
 *  2. Home-scope pointer delegation to a canonical repo bookmark
 *  3. Hard staleness block at 72h (instead of soft warning only)
 *
 * Cascade:
 *  1. bookmark.context.md — if present and useful
 *     1a. If identity scope=home + points_to_canonical, follow the pointer
 *     1b. If identity scope=repo and path mismatch, prefix a warning
 *     1c. If age >= STALENESS_HARD_BLOCK_HOURS, return staleness block
 *  2. LATEST.md — file tracking fallback
 *  3. Empty
 */
export function restoreContext(options: RestoreOptions): HookOutput {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const sessionId = options.sessionId;
  // Per-session layout is active once any session has sealed a handoff.
  // Decide before the transition below creates this session's directory.
  const lineageRecords = listLineage(storagePath);

  handleSessionTransition(storagePath, options, config.thresholds);

  const stopRequestedPath = join(storagePath, '.stop-requested');
  if (existsSync(stopRequestedPath)) {
    try { unlinkSync(stopRequestedPath); } catch { /* ignore */ }
  }
  if (sessionId) {
    const sessionMarker = getSessionStopMarkerPath(storagePath, sessionId);
    if (existsSync(sessionMarker)) {
      try { unlinkSync(sessionMarker); } catch { /* ignore */ }
    }
  }

  if (!config.restoreOnSessionStart) return {};
  if (options.source === 'resume') return {};

  const env = options.env ?? process.env;
  const source = options.source ?? 'startup';

  // C8': a fresh Easy Terminal reset marker names the exact file to resume; only /clear consumes it.
  if (source === 'clear') {
    const marker = readResetMarker(env);
    if (marker) {
      const message = buildVerifiedRestoration(
        [
          `[Bookmark: resuming the handoff Easy Terminal named for this pane before the reset]`,
          `Pane: ${env.EASY_TERMINAL_PANE_ID?.trim() ?? 'none'}`,
          `Path: ${marker.path}`,
          `sha256: ${marker.sha256}`,
          ...(marker.writtenAt ? [`Reset requested: ${marker.writtenAt}${marker.provider ? ` (${marker.provider})` : ''}`] : []),
        ],
        marker.path,
        marker.sha256
      );
      consumeResetMarker(marker);
      trackRestore(storagePath, sessionId, message.length);
      touchLastProject(options.cwd);
      return { systemMessage: message };
    }
  }

  if (lineageRecords.length > 0) {
    const paneId = options.paneId ?? currentPaneId(env);
    const pid = options.pid ?? currentClaudePid(env);
    const key = lineageKey({ paneId, pid, sessionId });
    const record = key ? readLineage(storagePath, key) : null;
    // After compaction the session continues; only its own handoff applies, else inject nothing.
    if (source === 'compact' && record?.session_id !== sessionId) return {};
    const message = record
      ? buildLineageRestoration(key!, record)
      : [
          `[Bookmark: no handoff is linked to this pane/session (${key ?? 'no pane or session id'}); pick one from the list]`,
          'Do not guess. Ask the owner which handoff to resume if none clearly matches, and verify its sha256 first.',
          '',
          buildHandoffIndex(storagePath),
        ].join('\n');
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }

  // Primary: bookmark.context.md with identity-aware handling
  const rawContextMd = readContextMd(storagePath);
  if (rawContextMd && !isGeneratedIndex(rawContextMd) && isContextMdUseful(rawContextMd)) {
    const contextPath = join(storagePath, 'bookmark.context.md');
    const { identity, bodyWithoutIdentity } = parseIdentity(rawContextMd);

    // 1a. Home-scope pointer? Follow it to the canonical repo bookmark.
    if (identity?.scope === 'home') {
      const target = followPointer(identity);
      if (target) {
        const targetAge = target.staleness_hours ?? 0;
        if (targetAge >= STALENESS_HARD_BLOCK_HOURS) {
          trackRestore(storagePath, sessionId, 0);
          return { systemMessage: buildHardStalenessMessage(target.canonical_path, targetAge) };
        }

        // Strip identity block from target content for cleaner display
        const { bodyWithoutIdentity: targetBody } = parseIdentity(target.content);
        const header = buildPointerFollowHeader(identity, target.canonical_path, targetAge);
        const message = `${header}\n\n${targetBody}`;
        trackRestore(storagePath, sessionId, message.length);
        if (identity.points_to_canonical) {
          touchLastProject(derivProjectFromCanonical(identity.points_to_canonical));
        }
        return { systemMessage: message };
      }
      // Pointer target missing — fall through to present the pointer body itself
    }

    // 1c. Hard staleness block
    const ageHours = getAgeHours(contextPath);
    if (ageHours !== null && ageHours >= STALENESS_HARD_BLOCK_HOURS) {
      trackRestore(storagePath, sessionId, 0);
      return { systemMessage: buildHardStalenessMessage(contextPath, ageHours) };
    }

    // 1b. Path-mismatch warning for repo-scoped identities
    const mismatchWarning = identity ? validateRepoIdentity(identity, options.cwd) : null;

    // Soft staleness warning
    const softWarning =
      ageHours !== null && ageHours >= STALENESS_SOFT_WARN_HOURS
        ? `[Note: This bookmark context is ${ageHours}h old and may be outdated.]`
        : null;

    const prefixes = [mismatchWarning, softWarning].filter(Boolean).join('\n\n');
    const message = prefixes ? `${prefixes}\n\n${bodyWithoutIdentity}` : bodyWithoutIdentity;
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }

  if (rawContextMd && !isGeneratedIndex(rawContextMd)) {
    trackBoilerplateCaught(storagePath, sessionId);
  }

  // Fallback: LATEST.md
  const snapshotCount = getSnapshotCount(storagePath);
  const latestMd = readLatestMd(storagePath);
  if (latestMd) {
    const message = buildFallbackRestoration(latestMd, snapshotCount);
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }

  // No local bookmark and no LATEST.md — stay silent rather than inject
  // another repo's context. The home-scope pointer at ~/.bookmark/bookmark.context.md
  // is the supported way to redirect from an empty CWD to a canonical project.
  return {};
}

/** Derive the project path from a canonical bookmark.context.md path. */
function derivProjectFromCanonical(canonicalPath: string): string {
  // .../<project>/.bookmark/bookmark.context.md → <project>
  const marker = `/.bookmark/`;
  const idx = canonicalPath.lastIndexOf(marker);
  return idx > 0 ? canonicalPath.slice(0, idx) : canonicalPath;
}

/**
 * A4: inject the predecessor's handoff with a C5 header naming session, pane,
 * path and sealed sha256. A changed or missing file is called out; the C5
 * verify line tells the agent to stop in that case.
 */
function buildLineageRestoration(key: string, record: LineageRecord): string {
  // Same staleness policy as the legacy file, measured from the seal time.
  const sealedMs = Date.parse(record.sealed_at);
  const ageHours = Number.isFinite(sealedMs) ? Math.round((Date.now() - sealedMs) / (1000 * 60 * 60)) : null;
  if (ageHours !== null && ageHours >= STALENESS_HARD_BLOCK_HOURS) {
    return buildHardStalenessMessage(record.handoff_path, ageHours);
  }
  const lines = [
    `[Bookmark: resuming the handoff linked to ${key}]`,
    ...(ageHours !== null && ageHours >= STALENESS_SOFT_WARN_HOURS
      ? [`[Note: This handoff was sealed ${ageHours}h ago and may be outdated.]`]
      : []),
    `Session: ${record.session_id}`,
    `Pane: ${record.pane ?? 'none'}`,
    `Path: ${record.handoff_path}`,
    `sha256: ${record.sha256}`,
    `Sealed: ${record.sealed_at}${record.head ? ` at HEAD ${record.head}` : ''}`,
  ];
  return buildVerifiedRestoration(lines, record.handoff_path, record.sha256);
}

/**
 * C5 header + body. A missing, unreadable or changed file is called out; the
 * verify line tells the agent to stop in that case. The body is still shown.
 */
function buildVerifiedRestoration(headerLines: string[], path: string, expectedSha: string): string {
  const lines = [...headerLines];
  let body: string | null = null;
  if (!existsSync(path)) {
    lines.push('WARNING: the handoff file is missing.');
  } else {
    try {
      const actual = sha256File(path);
      if (actual !== expectedSha) {
        lines.push(`WARNING: the file's current sha256 is ${actual}, not the sealed ${expectedSha}. It changed after sealing.`);
      }
      body = readFileSync(path, 'utf-8');
    } catch {
      lines.push('WARNING: the handoff file could not be read.');
    }
  }
  lines.push(verifyLine(path, expectedSha));
  return body === null ? lines.join('\n') : `${lines.join('\n')}\n\n${body}`;
}

/** Record a successful restore — chars injected / 4 ≈ tokens */
function trackRestore(storagePath: string, sessionId: string | undefined, charCount: number): void {
  try {
    const state = loadSessionState(storagePath, sessionId);
    state.restores_performed = (state.restores_performed ?? 0) + 1;
    state.tokens_injected = (state.tokens_injected ?? 0) + Math.round(charCount / 4);
    saveSessionState(storagePath, sessionId, state);
  } catch { /* never break restore for tracking */ }
}

function trackBoilerplateCaught(storagePath: string, sessionId: string | undefined): void {
  try {
    const state = loadSessionState(storagePath, sessionId);
    state.boilerplate_caught = (state.boilerplate_caught ?? 0) + 1;
    saveSessionState(storagePath, sessionId, state);
  } catch { /* never break restore for tracking */ }
}

function isContextMdUseful(content: string): boolean {
  if (content.length < 200) return false;
  if (content.startsWith('[Bookmark Context') && !content.includes('## ')) return false;
  const markers = ['## ', '**Task', '**Status', '**Progress', 'done', 'remaining', '- '];
  return markers.some(m => content.includes(m));
}

function getAgeHours(path: string): number | null {
  try {
    const mtime = statSync(path).mtimeMs;
    return Math.round((Date.now() - mtime) / (1000 * 60 * 60));
  } catch {
    return null;
  }
}

function buildHardStalenessMessage(path: string, ageHours: number): string {
  return [
    `[Bookmark: auto-restore BLOCKED — source is ${ageHours}h stale (threshold ${STALENESS_HARD_BLOCK_HOURS}h).]`,
    '',
    `The bookmark file at ${path} is too old to treat as current context.`,
    'Stale auto-restore creates confident wrong starts — worse than no restore at all.',
    '',
    'To proceed, either:',
    '- Run `/bookmark:list` and pick a specific snapshot explicitly',
    '- Read the stale file manually if you still want its content: ' +
      `\`cat "${path}"\``,
    '- Ask the user what they were working on most recently',
  ].join('\n');
}

function buildPointerFollowHeader(
  pointer: BookmarkIdentity,
  canonicalPath: string,
  ageHours: number
): string {
  const lines = [
    `[Bookmark: followed home-scope pointer → repo-scope bookmark]`,
    '',
    `Canonical file: ${canonicalPath}`,
  ];
  if (pointer.points_to_project) {
    lines.push(`Project: ${pointer.points_to_project}`);
  }
  if (ageHours >= STALENESS_SOFT_WARN_HOURS) {
    lines.push(`Age: ${ageHours}h (approaching staleness threshold of ${STALENESS_HARD_BLOCK_HOURS}h)`);
  }
  return lines.join('\n');
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
  options: RestoreOptions,
  thresholds: number[]
): void {
  const source = options.source ?? 'startup';
  const sessionId = options.sessionId ?? `session_${Date.now()}`;
  const state = loadSessionState(storagePath, options.sessionId);

  let updatedState: BookmarkState;

  switch (source) {
    case 'startup':
    case 'clear':
      // A per-session state seeded for this id is already fresh.
      updatedState = state.session_id === sessionId
        ? { ...state, current_threshold: thresholds[0], last_event_time: Date.now() }
        : resetForNewSession(state, sessionId, thresholds);
      break;

    case 'compact':
      updatedState = incrementCompaction(state, thresholds);
      updatedState.session_id = sessionId;
      break;

    case 'resume':
      updatedState = { ...state, session_id: sessionId, last_event_time: Date.now() };
      break;

    default:
      updatedState = state;
  }

  if (!existsSync(storagePath)) return;
  saveSessionState(storagePath, options.sessionId, updatedState);
}
