import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot, FileActivity } from '../types.js';

/**
 * Trail-routed memory writer.
 *
 * Writes file tracking data to trails/files.md.
 * bookmark.context.md is Claude's domain — written via Stop/PreCompact prompt hooks.
 */

// ─── Public API ───

export function writeTrails(storagePath: string, snapshot: Snapshot): void {
  const trailsDir = ensureTrailsDir(storagePath);
  writeFileTrail(trailsDir, snapshot);
}

// ─── File Trail ───

function writeFileTrail(
  trailsDir: string,
  snapshot: Snapshot
): { count: number; totalLines: number; topFiles: Array<{ path: string; summary?: string }> } {
  const trailPath = join(trailsDir, 'files.md');

  // Load existing file entries and merge with new
  const fileMap = loadFileEntries(trailPath);

  for (const f of snapshot.files_changed) {
    const shortPath = f.path.startsWith(snapshot.project_path)
      ? f.path.slice(snapshot.project_path.length).replace(/^\//, '')
      : f.path;

    const existing = fileMap.get(shortPath);
    if (existing) {
      const ops = new Set([...existing.operations, ...f.operations]);
      existing.operations = [...ops];
      // Use max, not sum — same transcript produces same totals across snapshots
      existing.lines_changed = Math.max(existing.lines_changed ?? 0, f.lines_changed ?? 0);
      // Merge summaries: combine unique structural hints
      if (f.summary) {
        if (existing.summary) {
          const existingHints = new Set(existing.summary.split(', '));
          const newHints = f.summary.split(', ');
          for (const h of newHints) existingHints.add(h);
          existing.summary = [...existingHints].slice(0, 6).join(', ');
        } else {
          existing.summary = f.summary;
        }
      }
    } else {
      fileMap.set(shortPath, {
        path: shortPath,
        operations: [...f.operations],
        lines_changed: f.lines_changed,
        summary: f.summary,
      });
    }
  }

  // Sort by lines changed descending
  const files = [...fileMap.values()].sort(
    (a, b) => (b.lines_changed ?? 0) - (a.lines_changed ?? 0)
  );

  const totalLines = files.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);

  const lines: string[] = [];
  lines.push('# File Trail');
  lines.push(`> ${files.length} files, ~${totalLines} lines changed total`);
  lines.push('');

  for (const f of files) {
    const lc = f.lines_changed ? ` ~${f.lines_changed}L` : '';
    let line = `- \`${f.path}\` (${f.operations.join('/')}${lc})`;
    if (f.summary) {
      line += ` — ${f.summary}`;
    }
    lines.push(line);
  }

  writeFileSync(trailPath, lines.join('\n'), 'utf-8');

  // Return top files with summaries for bookmark.context.md
  const topFiles = files
    .filter(f => f.summary)
    .slice(0, 5)
    .map(f => ({ path: f.path, summary: f.summary }));

  return { count: files.length, totalLines, topFiles };
}

function loadFileEntries(trailPath: string): Map<string, FileActivity> {
  if (!existsSync(trailPath)) return new Map();

  try {
    const content = readFileSync(trailPath, 'utf-8');
    const fileMap = new Map<string, FileActivity>();

    for (const line of content.split('\n')) {
      // Parse: - `src/foo.ts` (edit/write ~123L) — +fn registerPlugin, +fn ensurePluginSymlink
      const match = line.match(/^- `(.+?)` \(([^)]+)\)/);
      if (match) {
        const path = match[1];
        const opsStr = match[2];
        const ops = opsStr.replace(/\s*~\d+L/, '').split('/') as FileActivity['operations'];
        const lcMatch = opsStr.match(/~(\d+)L/);
        const linesChanged = lcMatch ? parseInt(lcMatch[1], 10) : undefined;
        // Extract summary after " — " if present
        const summaryMatch = line.match(/\) — (.+)$/);
        const summary = summaryMatch ? summaryMatch[1] : undefined;
        fileMap.set(path, { path, operations: ops, lines_changed: linesChanged, summary });
      }
    }

    return fileMap;
  } catch {
    return new Map();
  }
}

// ─── Helpers ───

function ensureTrailsDir(storagePath: string): string {
  const trailsDir = join(storagePath, 'trails');
  if (!existsSync(trailsDir)) {
    mkdirSync(trailsDir, { recursive: true });
  }
  return trailsDir;
}
