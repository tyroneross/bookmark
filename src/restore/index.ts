import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readLatestMd, getSnapshotCount } from '../snapshot/storage.js';
import { readContextMd } from '../trails/reader.js';
import {
  parseIdentity,
  validateRepoIdentity,
  followPointer,
  type BookmarkIdentity,
} from '../trails/identity.js';
import { loadState, saveState, resetForNewSession, incrementCompaction } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import { touchLastProject, getLastProject } from '../registry.js';
import type { HookOutput, BookmarkState } from '../types.js';

export interface RestoreOptions {
  source?: 'startup' | 'resume' | 'compact' | 'clear';
  sessionId?: string;
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
  const state = loadState(storagePath);

  handleSessionTransition(storagePath, state, options, config.thresholds);

  const stopRequestedPath = join(storagePath, '.stop-requested');
  if (existsSync(stopRequestedPath)) {
    try { unlinkSync(stopRequestedPath); } catch { /* ignore */ }
  }

  if (!config.restoreOnSessionStart) return {};
  if (options.source === 'resume') return {};

  // Primary: bookmark.context.md with identity-aware handling
  const rawContextMd = readContextMd(storagePath);
  if (rawContextMd && isContextMdUseful(rawContextMd)) {
    const contextPath = join(storagePath, 'bookmark.context.md');
    const { identity, bodyWithoutIdentity } = parseIdentity(rawContextMd);

    // 1a. Home-scope pointer? Follow it to the canonical repo bookmark.
    if (identity?.scope === 'home') {
      const target = followPointer(identity);
      if (target) {
        const targetAge = target.staleness_hours ?? 0;
        if (targetAge >= STALENESS_HARD_BLOCK_HOURS) {
          trackRestore(storagePath, 0);
          return { systemMessage: buildHardStalenessMessage(target.canonical_path, targetAge) };
        }

        // Strip identity block from target content for cleaner display
        const { bodyWithoutIdentity: targetBody } = parseIdentity(target.content);
        const header = buildPointerFollowHeader(identity, target.canonical_path, targetAge);
        const message = `${header}\n\n${targetBody}`;
        trackRestore(storagePath, message.length);
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
      trackRestore(storagePath, 0);
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
    trackRestore(storagePath, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }

  if (rawContextMd) {
    trackBoilerplateCaught(storagePath);
  }

  // Fallback: LATEST.md
  const snapshotCount = getSnapshotCount(storagePath);
  const latestMd = readLatestMd(storagePath);
  if (latestMd) {
    const message = buildFallbackRestoration(latestMd, snapshotCount);
    trackRestore(storagePath, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }

  // Final fallback: registry last_project (post-/clear from an empty CWD)
  const last = getLastProject();
  if (last && last.path !== options.cwd) {
    const lastStorage = join(last.path, config.storagePath);
    const lastContext = readContextMd(lastStorage);
    if (lastContext && isContextMdUseful(lastContext)) {
      const { bodyWithoutIdentity } = parseIdentity(lastContext);
      const header = [
        `[Bookmark: no local context — restored from last-active project via registry]`,
        '',
        `Project: ${last.name}`,
        `Path:    ${last.path}`,
      ].join('\n');
      const message = `${header}\n\n${bodyWithoutIdentity}`;
      trackRestore(storagePath, message.length);
      return { systemMessage: message };
    }
  }

  return {};
}

/** Derive the project path from a canonical bookmark.context.md path. */
function derivProjectFromCanonical(canonicalPath: string): string {
  // .../<project>/.bookmark/bookmark.context.md → <project>
  const marker = `/.bookmark/`;
  const idx = canonicalPath.lastIndexOf(marker);
  return idx > 0 ? canonicalPath.slice(0, idx) : canonicalPath;
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

function trackBoilerplateCaught(storagePath: string): void {
  try {
    const state = loadState(storagePath);
    state.boilerplate_caught = (state.boilerplate_caught ?? 0) + 1;
    saveState(storagePath, state);
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
      updatedState = resetForNewSession(state, sessionId, thresholds);
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
  saveState(storagePath, updatedState);
}
