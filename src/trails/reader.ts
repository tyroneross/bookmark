import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the CONTEXT.md trailhead file.
 * This is the primary restoration source — compact (<400 tokens)
 * with routing pointers to deeper trail files.
 */
export function readContextMd(storagePath: string): string | null {
  const contextPath = join(storagePath, 'CONTEXT.md');
  if (!existsSync(contextPath)) return null;
  try {
    const content = readFileSync(contextPath, 'utf-8');
    if (!content.trim()) return null;
    return content;
  } catch {
    return null;
  }
}
