import type { Snapshot } from '../types.js';

/**
 * Compress a full snapshot into a concise markdown summary.
 * Target: <150 lines, <1000 tokens.
 * This becomes LATEST.md — the hot context tier.
 */
export function compressToMarkdown(snapshot: Snapshot): string {
  const lines: string[] = [];

  // Header
  const date = new Date(snapshot.timestamp).toISOString();
  lines.push(`# Session Context - Last Updated ${date}`);
  lines.push('');
  lines.push(`> Snapshot: ${snapshot.snapshot_id} | Compaction cycle: ${snapshot.compaction_cycle} | Trigger: ${snapshot.trigger}`);
  lines.push(`> Context remaining: ${Math.round(snapshot.context_remaining_pct * 100)}% (~${snapshot.token_estimate.toLocaleString()} tokens used)`);
  lines.push('');

  // Current Status
  if (snapshot.current_status && snapshot.current_status !== 'No status available') {
    lines.push('## Current Status');
    lines.push(truncate(snapshot.current_status, 300));
    lines.push('');
  }

  // Decisions
  if (snapshot.decisions.length > 0) {
    lines.push('## Decisions Made');
    for (const d of snapshot.decisions.slice(0, 8)) {
      const rationale = d.rationale ? ` (${truncate(d.rationale, 80)})` : '';
      lines.push(`- ${truncate(d.description, 150)}${rationale}`);
    }
    if (snapshot.decisions.length > 8) {
      lines.push(`- ...and ${snapshot.decisions.length - 8} more`);
    }
    lines.push('');
  }

  // Files Changed
  if (snapshot.files_changed.length > 0) {
    lines.push('## Files Changed This Session');
    for (const f of snapshot.files_changed.slice(0, 12)) {
      const ops = f.operations.join(', ');
      lines.push(`- \`${f.path}\` (${ops})`);
    }
    if (snapshot.files_changed.length > 12) {
      lines.push(`- ...and ${snapshot.files_changed.length - 12} more files`);
    }
    lines.push('');
  }

  // Open Items
  if (snapshot.open_items.length > 0) {
    lines.push('## Open Items');
    for (const item of snapshot.open_items.slice(0, 8)) {
      const priority = item.priority === 'high' ? ' [HIGH]' : item.priority === 'medium' ? ' [MED]' : '';
      lines.push(`- [ ] ${truncate(item.description, 150)}${priority}`);
    }
    if (snapshot.open_items.length > 8) {
      lines.push(`- ...and ${snapshot.open_items.length - 8} more`);
    }
    lines.push('');
  }

  // Unknowns / Blockers
  if (snapshot.unknowns.length > 0) {
    lines.push('## Unknowns / Blockers');
    for (const u of snapshot.unknowns.slice(0, 5)) {
      lines.push(`- ${truncate(u, 150)}`);
    }
    lines.push('');
  }

  // Errors (only unresolved)
  const unresolvedErrors = snapshot.errors_encountered.filter(e => !e.resolved);
  if (unresolvedErrors.length > 0) {
    lines.push('## Unresolved Errors');
    for (const e of unresolvedErrors.slice(0, 3)) {
      const tool = e.tool ? ` (${e.tool})` : '';
      lines.push(`- ${truncate(e.message, 150)}${tool}`);
    }
    lines.push('');
  }

  // Tool Usage Summary (compact)
  if (Object.keys(snapshot.tools_summary).length > 0) {
    const topTools = Object.entries(snapshot.tools_summary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => `${tool}: ${count}`)
      .join(', ');
    lines.push(`> Tool usage: ${topTools}`);
    lines.push('');
  }

  lines.push('*bookmark — context snapshot*');

  return lines.join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
