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
    if (contextStat.size < 200) return false;
    if (now - contextStat.mtimeMs >= MAX_HANDOFF_AGE_MS) return false;

    if (existsSync(markerPath) && contextStat.mtimeMs <= statSync(markerPath).mtimeMs) {
      return false;
    }

    const content = readFileSync(contextPath, 'utf8');
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
