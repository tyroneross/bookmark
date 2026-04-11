/**
 * BOOKMARK_IDENTITY block parser + validator.
 *
 * The identity block is an HTML comment at the top of bookmark.context.md
 * that declares which project/repo/branch the summary belongs to. It makes
 * cross-session restoration unambiguous — you can always verify the
 * bookmark you're restoring from matches the CWD you're restoring into.
 *
 * Example:
 *   <!-- BOOKMARK_IDENTITY
 *   scope: repo
 *   project: travel-planner
 *   repo_path: /Users/me/Desktop/git-folder/Travel Planner
 *   branch: feature/summer-camps
 *   head: 4988383
 *   written: 2026-04-11
 *   -->
 *
 * Two scopes are supported:
 *  - `repo`    — bookmark belongs to a specific git repo (or directory)
 *  - `home`    — bookmark is a POINTER, no active context itself; delegates
 *                via `points_to_canonical` to a repo-scoped bookmark
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type BookmarkScope = 'repo' | 'home';

export interface BookmarkIdentity {
  scope: BookmarkScope;
  project?: string;
  repo_path?: string;
  repo_name?: string;
  branch?: string;
  head?: string;
  base?: string;
  written?: string;
  written_by?: string;
  points_to_project?: string;
  points_to_repo?: string;
  points_to_canonical?: string;
  /** All raw key:value pairs, for forward-compat keys we don't model */
  raw: Record<string, string>;
}

export interface IdentityParseResult {
  identity: BookmarkIdentity | null;
  /** Content with the identity block stripped, ready to present */
  bodyWithoutIdentity: string;
}

const IDENTITY_BLOCK = /<!--\s*BOOKMARK_IDENTITY\s*\n([\s\S]*?)\n\s*-->/;

/**
 * Parse a bookmark.context.md file's content and extract the identity block.
 * Returns `identity: null` if no block is present — callers should treat that
 * as a legacy/untagged file and fall back to current behavior.
 */
export function parseIdentity(content: string): IdentityParseResult {
  const match = content.match(IDENTITY_BLOCK);
  if (!match) {
    return { identity: null, bodyWithoutIdentity: content };
  }

  const raw: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    raw[key] = value;
  }

  const scopeRaw = (raw.scope ?? 'repo').toLowerCase();
  const scope: BookmarkScope = scopeRaw === 'home' ? 'home' : 'repo';

  const identity: BookmarkIdentity = {
    scope,
    project: raw.project,
    repo_path: raw.repo_path,
    repo_name: raw.repo_name,
    branch: raw.branch,
    head: raw.head,
    base: raw.base,
    written: raw.written,
    written_by: raw.written_by,
    points_to_project: raw.points_to_project,
    points_to_repo: raw.points_to_repo,
    points_to_canonical: raw.points_to_canonical,
    raw,
  };

  // Body with block stripped — preserve surrounding content
  const bodyWithoutIdentity =
    content.slice(0, match.index) + content.slice(match.index! + match[0].length);

  return { identity, bodyWithoutIdentity: bodyWithoutIdentity.replace(/^\s*\n+/, '') };
}

/**
 * Validate a repo-scoped identity against the storage path that was loaded.
 *
 * Returns a warning string if the identity's `repo_path` disagrees with the
 * working directory, suggesting the bookmark file was moved or the CWD is
 * not the repo it describes. Returns null when they match or when we can't
 * determine (missing field).
 */
export function validateRepoIdentity(
  identity: BookmarkIdentity,
  cwd: string
): string | null {
  if (identity.scope !== 'repo') return null;
  if (!identity.repo_path) return null;

  const declared = resolve(identity.repo_path);
  const actual = resolve(cwd);

  if (declared === actual) return null;

  // Allow the case where CWD is a subdirectory of the declared repo
  if (actual.startsWith(declared + '/')) return null;

  return (
    `[Bookmark identity mismatch] This bookmark.context.md declares ` +
    `repo_path=${declared} but was loaded from cwd=${actual}. ` +
    `Verify you are in the correct project before acting on the context below.`
  );
}

/**
 * Follow a home-scope pointer to its canonical file.
 *
 * If the identity is home-scoped and has `points_to_canonical`, return the
 * content of that file (plus its own parsed identity). Returns null if the
 * pointer target doesn't exist or isn't readable — caller should fall back
 * to presenting the pointer body itself.
 */
export interface PointerTarget {
  canonical_path: string;
  content: string;
  identity: BookmarkIdentity | null;
  staleness_hours: number | null;
}

export function followPointer(identity: BookmarkIdentity): PointerTarget | null {
  if (identity.scope !== 'home') return null;
  if (!identity.points_to_canonical) return null;

  const target = identity.points_to_canonical;
  if (!existsSync(target)) return null;

  try {
    const content = readFileSync(target, 'utf-8');
    const mtime = statSync(target).mtimeMs;
    const staleness_hours = Math.round((Date.now() - mtime) / (1000 * 60 * 60));
    const { identity: targetIdentity } = parseIdentity(content);
    return {
      canonical_path: target,
      content,
      identity: targetIdentity,
      staleness_hours,
    };
  } catch {
    return null;
  }
}
