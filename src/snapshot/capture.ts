import { parseTranscript } from '../transcript/parser.js';
import { estimateFromTranscript } from '../transcript/estimator.js';
import { extractFromEntries } from '../transcript/extractor.js';
import { storeSnapshot, writeLatestMd, loadLatestSnapshot } from './storage.js';
import { compressToMarkdown } from './compress.js';
import { writeTrails } from '../trails/writer.js';
import { loadState, saveState, updateSnapshotTime } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import type { Snapshot, SnapshotTrigger } from '../types.js';

export interface CaptureOptions {
  trigger: SnapshotTrigger;
  transcriptPath: string;
  cwd: string;
  sessionId?: string;
}

/**
 * Full snapshot capture pipeline:
 * 1. Parse transcript
 * 2. Estimate token usage
 * 3. Extract decisions/status/files via pattern matching (fast, zero cost)
 * 4. Build snapshot object
 * 5. Store snapshot JSON
 * 6. Write LATEST.md + trail-routed files (CONTEXT.md, decisions.md, files.md)
 * 7. Update state
 *
 * No external API calls — the running Claude Code instance interprets the
 * trail files on restore. Pattern matching captures the structured data;
 * Claude (already running, already paid for) does the smart interpretation.
 */
export async function captureSnapshot(options: CaptureOptions): Promise<Snapshot> {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadState(storagePath);

  // 1. Parse transcript
  const { entries } = parseTranscript(options.transcriptPath);

  // 2. Estimate token usage
  const estimate = estimateFromTranscript(options.transcriptPath, {
    contextLimit: config.contextLimitTokens,
    charsPerToken: config.charsPerToken,
  });

  // 3. Extract structural content via pattern matching (fast, zero external cost)
  const extraction = extractFromEntries(entries, { projectPath: options.cwd });

  // 4. Build snapshot
  const snapshotId = generateSnapshotId();
  const priorSnapshot = loadLatestSnapshot(storagePath);

  const snapshot: Snapshot = {
    snapshot_id: snapshotId,
    timestamp: Date.now(),
    session_id: options.sessionId ?? state.session_id ?? 'unknown',
    project_path: options.cwd,
    trigger: options.trigger,
    compaction_cycle: state.compaction_count,
    context_remaining_pct: estimate.remaining_pct,
    token_estimate: estimate.total_tokens,
    intent: extraction.intent ?? 'Unknown',
    progress: extraction.progress ?? 'Unknown',
    current_status: extraction.current_status,
    decisions: extraction.decisions,
    open_items: extraction.open_items,
    unknowns: extraction.unknowns,
    files_changed: extraction.files_changed,
    errors_encountered: extraction.errors_encountered,
    tools_summary: extraction.tools_summary,
    user_sentiment: extraction.user_sentiment,
    prior_snapshot_id: priorSnapshot?.snapshot_id,
  };

  // 5. Store snapshot
  storeSnapshot(storagePath, snapshot);

  // 6. Write LATEST.md + trail-routed files — only update if snapshot has content
  const hasContent = snapshot.files_changed.length > 0
    || snapshot.decisions.length > 0
    || snapshot.open_items.length > 0;
  if (hasContent || snapshot.trigger === 'manual') {
    const markdown = compressToMarkdown(snapshot);
    writeLatestMd(storagePath, markdown);
    writeTrails(storagePath, snapshot);
  }

  // 7. Update state
  const updatedState = updateSnapshotTime(state);
  saveState(storagePath, updatedState);

  return snapshot;
}

function generateSnapshotId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `SNAP_${date}_${time}`;
}
