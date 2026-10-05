import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseIdentity } from '../trails/identity.js';
import { REQUIRED_HANDOFF_HEADINGS } from './handoff-prompt.js';

const MAX_HANDOFF_AGE_MS = 2 * 60 * 1000;

/** Check whether Stop can trust the semantic handoff for a cold restart. */
export function isContextMdFresh(
  contextPath: string,
  markerPath: string,
  now = Date.now()
): boolean {
  if (!existsSync(contextPath)) return false;

  try {
    const contextStat = statSync(contextPath);
    if (now - contextStat.mtimeMs >= MAX_HANDOFF_AGE_MS) return false;

    if (existsSync(markerPath) && contextStat.mtimeMs <= statSync(markerPath).mtimeMs) {
      return false;
    }

    return passesHandoffChecks(contextPath);
  } catch {
    return false;
  }
}

/**
 * Content checks only (no age): repo identity with project and repo_path and
 * every required heading. The generated repo-level index never passes.
 */
export function passesHandoffChecks(path: string): boolean {
  try {
    if (statSync(path).size < 200) return false;
    const content = readFileSync(path, 'utf8');
    if (content.startsWith('<!-- BOOKMARK_INDEX')) return false;
    const { identity } = parseIdentity(content);
    if (identity?.scope !== 'repo' || !identity.project || !identity.repo_path) return false;

    const headings = new Set(
      [...content.matchAll(/^##\s+(.+?)\s*$/gim)].map(match => match[1].toLowerCase())
    );
    return REQUIRED_HANDOFF_HEADINGS.every(heading => headings.has(heading.toLowerCase()));
  } catch {
    return false;
  }
}
