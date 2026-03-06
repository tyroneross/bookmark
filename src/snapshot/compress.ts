import type { Snapshot } from '../types.js';
import { basename } from 'node:path';

/**
 * Compress a snapshot into markdown — now focused on file tracking data only.
 * Intent/decisions/progress come from Claude-written bookmark.context.md, not this.
 * This becomes LATEST.md — supplementary file change data.
 */
export function compressToMarkdown(snapshot: Snapshot): string {
  const lines: string[] = [];

  const date = new Date(snapshot.timestamp).toISOString();
  lines.push(`# File Changes - ${date}`);
  lines.push('');
  lines.push(`> ${snapshot.snapshot_id} | cycle ${snapshot.compaction_cycle} | ${snapshot.trigger}`);
  lines.push('');

  // Files Changed — the core value of this snapshot
  if (snapshot.files_changed.length > 0) {
    const totalLines = snapshot.files_changed.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);
    lines.push(`## Files Changed (${snapshot.files_changed.length} files, ~${totalLines} lines)`);
    for (const f of snapshot.files_changed.slice(0, 10)) {
      const shortPath = shortenPath(f.path, snapshot.project_path);
      const ops = f.operations.join('/');
      const lc = f.lines_changed ? ` ~${f.lines_changed}L` : '';
      lines.push(`- \`${shortPath}\` (${ops}${lc})`);
    }
    if (snapshot.files_changed.length > 10) {
      lines.push(`- ...+${snapshot.files_changed.length - 10} more`);
    }
    lines.push('');
  }

  // Tool usage — single line summary
  if (Object.keys(snapshot.tools_summary).length > 0) {
    const topTools = Object.entries(snapshot.tools_summary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => `${tool}: ${count}`)
      .join(', ');
    lines.push(`> Tools: ${topTools}`);
    lines.push('');
  }

  lines.push('*bookmark — file tracking snapshot*');

  return lines.join('\n');
}

/** Shorten a file path relative to project root */
function shortenPath(filePath: string, projectPath: string): string {
  if (projectPath && filePath.startsWith(projectPath)) {
    return filePath.slice(projectPath.length).replace(/^\//, '');
  }
  return basename(filePath);
}
