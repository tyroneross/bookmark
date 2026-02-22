import type { Snapshot } from '../types.js';
import { basename } from 'node:path';

/**
 * Compress a full snapshot into a concise markdown summary.
 * Target: <100 lines, <800 tokens — just enough for an LLM to pick up where it left off.
 * This becomes LATEST.md — the hot context tier.
 */
export function compressToMarkdown(snapshot: Snapshot): string {
  const lines: string[] = [];

  // Header (compact)
  const date = new Date(snapshot.timestamp).toISOString();
  lines.push(`# Session Context - ${date}`);
  lines.push('');
  const sentiment = snapshot.user_sentiment && snapshot.user_sentiment !== 'neutral'
    ? ` | user: ${snapshot.user_sentiment}`
    : '';
  lines.push(`> ${snapshot.snapshot_id} | cycle ${snapshot.compaction_cycle} | ${snapshot.trigger} | ${Math.round(snapshot.context_remaining_pct * 100)}% ctx remaining${sentiment}`);
  lines.push('');

  // Intent — THE most important section. What is the user trying to do?
  if (snapshot.intent && snapshot.intent !== 'Unknown') {
    lines.push('## Intent');
    lines.push(snapshot.intent);
    lines.push('');
  }

  // Progress — How far along?
  if (snapshot.progress && snapshot.progress !== 'Unknown') {
    lines.push('## Progress');
    lines.push(snapshot.progress);
    lines.push('');
  }

  // Key Decisions — only if present
  if (snapshot.decisions.length > 0) {
    lines.push('## Key Decisions');
    for (const d of snapshot.decisions.slice(0, 4)) {
      lines.push(`- ${truncate(d.description, 120)}`);
    }
    lines.push('');
  }

  // Open Items — remaining work
  if (snapshot.open_items.length > 0) {
    lines.push('## Open Items');
    for (const item of snapshot.open_items.slice(0, 4)) {
      const priority = item.priority === 'high' ? ' [HIGH]' : item.priority === 'medium' ? ' [MED]' : '';
      lines.push(`- [ ] ${truncate(item.description, 120)}${priority}`);
    }
    lines.push('');
  }

  // Files Changed — use short paths with line counts
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

  // Unknowns — only if present, very compact
  if (snapshot.unknowns.length > 0) {
    lines.push('## Blockers');
    for (const u of snapshot.unknowns.slice(0, 3)) {
      lines.push(`- ${truncate(u, 100)}`);
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

  lines.push('*bookmark — context snapshot*');

  return lines.join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/** Shorten a file path relative to project root */
function shortenPath(filePath: string, projectPath: string): string {
  if (projectPath && filePath.startsWith(projectPath)) {
    return filePath.slice(projectPath.length).replace(/^\//, '');
  }
  // Fall back to basename for external paths
  return basename(filePath);
}
