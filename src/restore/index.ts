import { existsSync } from 'node:fs';
import { readLatestMd, loadLatestSnapshot, getSnapshotCount, loadSnapshotChain } from '../snapshot/storage.js';
import { readContextMd } from '../trails/reader.js';
import { loadState, saveState, resetForNewSession, incrementCompaction } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import type { HookOutput, BookmarkState, Snapshot, FileActivity, Decision, OpenItem } from '../types.js';

export interface RestoreOptions {
  source?: 'startup' | 'resume' | 'compact' | 'clear';
  sessionId?: string;
  cwd: string;
  format?: 'system_message' | 'json' | 'markdown';
}

/**
 * Generate restoration context for a SessionStart hook.
 * Returns a HookOutput with systemMessage containing the LATEST.md content.
 */
export function restoreContext(options: RestoreOptions): HookOutput {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadState(storagePath);

  // Handle session state transitions
  handleSessionTransition(storagePath, state, options, config.thresholds);

  // Check if restoration is needed
  if (!config.restoreOnSessionStart) {
    return {};
  }

  // On resume, context is likely intact — skip restoration
  if (options.source === 'resume') {
    return {};
  }

  // Check for existing snapshots
  const snapshotCount = getSnapshotCount(storagePath);
  if (snapshotCount === 0) {
    // First run — tell Claude that bookmark is active
    return {
      systemMessage:
        '[Bookmark: Active — no snapshots yet. Snapshots will be captured automatically ' +
        'before compaction, on 20-minute intervals, and at session end.]\n\n' +
        'Briefly let the user know that Bookmark is active and will start capturing context snapshots automatically.',
    };
  }

  // Read LATEST.md
  const latestMd = readLatestMd(storagePath);
  if (!latestMd) {
    return {};
  }

  if (options.format === 'json') {
    const snapshot = loadLatestSnapshot(storagePath);
    return {
      systemMessage: JSON.stringify(snapshot, null, 2),
    };
  }

  if (options.format === 'markdown') {
    return {
      systemMessage: latestMd,
    };
  }

  // Default: system_message format — structured for fast LLM pickup
  // Prefer trail-routed CONTEXT.md (compact trailhead with routing pointers)
  const contextMd = readContextMd(storagePath);
  if (contextMd) {
    return { systemMessage: contextMd };
  }

  // Fallback: chain-aware restoration from raw snapshots
  const chain = loadSnapshotChain(storagePath);
  if (chain.length > 1) {
    const merged = mergeSnapshotChain(chain);
    return { systemMessage: buildChainRestoration(merged, chain.length, snapshotCount) };
  }

  const snapshot = loadLatestSnapshot(storagePath);
  const systemMessage = snapshot
    ? buildSmartRestoration(snapshot, snapshotCount)
    : buildFallbackRestoration(latestMd, snapshotCount);
  return { systemMessage };
}

// ─── Snapshot Chain Merging ───

interface MergedContext {
  intent: string;
  progress: string;
  sentiment: string;
  files: FileActivity[];
  decisions: Decision[];
  openItems: OpenItem[];
  projectPath: string;
  compactionCycle: number;
  totalLinesChanged: number;
  chainSpan: { oldest: number; newest: number };
}

/**
 * Merge a chain of snapshots into one unified context.
 * Chain is in chronological order (oldest first).
 *
 * Strategy:
 * - Intent/progress: Latest non-Unknown wins (most current)
 * - Files: Union by path, merge operations, sum line counts
 * - Decisions: Accumulate unique across chain, cap at 6
 * - Open items: Latest snapshot only (prior items are done or superseded)
 * - Sentiment: Latest non-neutral wins
 */
function mergeSnapshotChain(chain: Snapshot[]): MergedContext {
  const latest = chain[chain.length - 1];
  const oldest = chain[0];

  // Intent/progress: walk backward, take first non-Unknown
  let intent = 'Unknown';
  let progress = 'Unknown';
  let sentiment = 'neutral';
  for (let i = chain.length - 1; i >= 0; i--) {
    if (intent === 'Unknown' && chain[i].intent && chain[i].intent !== 'Unknown') {
      intent = chain[i].intent;
    }
    if (progress === 'Unknown' && chain[i].progress && chain[i].progress !== 'Unknown') {
      progress = chain[i].progress;
    }
    if (sentiment === 'neutral' && chain[i].user_sentiment && chain[i].user_sentiment !== 'neutral') {
      sentiment = chain[i].user_sentiment!;
    }
  }

  // Files: merge by path across all snapshots
  const fileMap = new Map<string, FileActivity>();
  for (const snap of chain) {
    for (const f of snap.files_changed) {
      const existing = fileMap.get(f.path);
      if (existing) {
        // Merge operations (union)
        const ops = new Set([...existing.operations, ...f.operations]);
        existing.operations = [...ops];
        // Sum line counts
        existing.lines_changed = (existing.lines_changed ?? 0) + (f.lines_changed ?? 0);
      } else {
        fileMap.set(f.path, { ...f });
      }
    }
  }

  // Decisions: accumulate unique across chain
  const decisionSet = new Set<string>();
  const allDecisions: Decision[] = [];
  for (const snap of chain) {
    for (const d of snap.decisions) {
      // Deduplicate by normalized prefix (first 60 chars, lowered)
      const key = d.description.slice(0, 60).toLowerCase().trim();
      if (!decisionSet.has(key)) {
        decisionSet.add(key);
        allDecisions.push(d);
      }
    }
  }

  // Open items: latest snapshot only
  const openItems = latest.open_items;

  const files = [...fileMap.values()];
  const totalLinesChanged = files.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);

  return {
    intent,
    progress,
    sentiment,
    files,
    decisions: allDecisions.slice(0, 6),
    openItems,
    projectPath: latest.project_path,
    compactionCycle: latest.compaction_cycle,
    totalLinesChanged,
    chainSpan: { oldest: oldest.timestamp, newest: latest.timestamp },
  };
}

/**
 * Build restoration from merged chain context.
 * Target: <600 tokens — covers multiple compaction cycles efficiently.
 */
function buildChainRestoration(merged: MergedContext, chainLength: number, snapshotCount: number): string {
  const lines: string[] = [];

  const spanMinutes = Math.round((merged.chainSpan.newest - merged.chainSpan.oldest) / 60000);
  const spanStr = spanMinutes > 60
    ? `${Math.round(spanMinutes / 60)}h ${spanMinutes % 60}m`
    : `${spanMinutes}m`;

  lines.push(`[Bookmark: Context recovered — ${chainLength} snapshots merged across ${spanStr}]`);
  lines.push('');

  // Intent
  if (merged.intent !== 'Unknown') {
    lines.push(`**User intent:** ${merged.intent}`);
  }

  // Progress
  if (merged.progress !== 'Unknown') {
    lines.push(`**Progress:** ${merged.progress}`);
  }

  // Sentiment
  if (merged.sentiment !== 'neutral') {
    lines.push(`**User feedback:** ${merged.sentiment}`);
  }

  lines.push('');

  // Files — show cumulative work
  if (merged.files.length > 0) {
    lines.push(`**Files modified:** ${merged.files.length} files (~${merged.totalLinesChanged} lines total)`);
    // Sort by lines changed descending — most important files first
    const sorted = [...merged.files].sort((a, b) => (b.lines_changed ?? 0) - (a.lines_changed ?? 0));
    for (const f of sorted.slice(0, 10)) {
      const shortPath = f.path.includes(merged.projectPath)
        ? f.path.slice(merged.projectPath.length).replace(/^\//, '')
        : f.path;
      const lc = f.lines_changed ? ` ~${f.lines_changed}L` : '';
      lines.push(`- \`${shortPath}\` (${f.operations.join('/')}${lc})`);
    }
    if (merged.files.length > 10) {
      lines.push(`- ...+${merged.files.length - 10} more`);
    }
    lines.push('');
  }

  // Decisions — accumulated across chain
  if (merged.decisions.length > 0) {
    lines.push('**Key decisions (across session):**');
    for (const d of merged.decisions) {
      lines.push(`- ${d.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  // Open items — from latest snapshot only
  if (merged.openItems.length > 0) {
    lines.push('**Remaining:**');
    for (const item of merged.openItems.slice(0, 4)) {
      lines.push(`- ${item.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  // Chain metadata
  if (merged.compactionCycle > 0) {
    lines.push(`> Compaction cycle ${merged.compactionCycle} — context compressed ${merged.compactionCycle} time(s), this merges all recovered state.`);
  }
  if (snapshotCount > chainLength) {
    lines.push(`> ${snapshotCount} total snapshots. \`/bookmark:list\` for full history.`);
  }

  lines.push('');
  lines.push('Resume working on the task above. Do not re-read files you already modified unless the user asks.');

  return lines.join('\n');
}

// ─── Single Snapshot Restoration ───

/**
 * Build a restoration message optimized for LLM context recovery.
 * Structured as a briefing: intent → progress → what changed → what's next.
 * Target: <500 tokens — every token here saves 10+ tokens of re-exploration.
 */
function buildSmartRestoration(snapshot: Snapshot, snapshotCount: number): string {
  const lines: string[] = [];

  lines.push('[Bookmark: Context recovered — pick up where you left off]');
  lines.push('');

  // Intent — what the user is trying to do
  if (snapshot.intent && snapshot.intent !== 'Unknown') {
    lines.push(`**User intent:** ${snapshot.intent}`);
  }

  // Progress — how far along
  if (snapshot.progress && snapshot.progress !== 'Unknown') {
    lines.push(`**Progress:** ${snapshot.progress}`);
  }

  // Sentiment — user's reaction to work so far
  if (snapshot.user_sentiment && snapshot.user_sentiment !== 'neutral') {
    lines.push(`**User feedback:** ${snapshot.user_sentiment}`);
  }

  lines.push('');

  // Files changed — concrete work done
  if (snapshot.files_changed.length > 0) {
    const totalLines = snapshot.files_changed.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);
    lines.push(`**Files modified:** ${snapshot.files_changed.length} files (~${totalLines} lines)`);
    for (const f of snapshot.files_changed.slice(0, 8)) {
      const shortPath = f.path.includes(snapshot.project_path)
        ? f.path.slice(snapshot.project_path.length).replace(/^\//, '')
        : f.path;
      const lc = f.lines_changed ? ` ~${f.lines_changed}L` : '';
      lines.push(`- \`${shortPath}\` (${f.operations.join('/')}${lc})`);
    }
    if (snapshot.files_changed.length > 8) {
      lines.push(`- ...+${snapshot.files_changed.length - 8} more`);
    }
    lines.push('');
  }

  // Key decisions — only if LLM-extracted (high quality)
  if (snapshot.decisions.length > 0) {
    lines.push('**Key decisions:**');
    for (const d of snapshot.decisions.slice(0, 4)) {
      lines.push(`- ${d.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  // Open items — what's left
  if (snapshot.open_items.length > 0) {
    lines.push('**Remaining:**');
    for (const item of snapshot.open_items.slice(0, 4)) {
      lines.push(`- ${item.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  // Compaction chain info
  if (snapshot.compaction_cycle > 0) {
    lines.push(`> Compaction cycle ${snapshot.compaction_cycle} — context was compressed, this is the recovered state.`);
  }
  if (snapshotCount > 1) {
    lines.push(`> ${snapshotCount} snapshots in history. \`/bookmark:list\` for full chain.`);
  }

  lines.push('');
  lines.push('Resume working on the task above. Do not re-read files you already modified unless the user asks.');

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
      // New session — reset compaction count
      updatedState = resetForNewSession(state, sessionId, thresholds);
      break;

    case 'compact':
      // After compaction — increment compaction count
      updatedState = incrementCompaction(state, thresholds);
      updatedState.session_id = sessionId;
      break;

    case 'resume':
      // Resuming — keep state, just update session ID if different
      updatedState = { ...state, session_id: sessionId, last_event_time: Date.now() };
      break;

    default:
      updatedState = state;
  }

  if (!existsSync(storagePath)) return;
  saveState(storagePath, updatedState);
}
