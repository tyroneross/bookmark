import { join } from 'node:path';
import { parseTranscript } from '../transcript/parser.js';
import { extractFilesAndTools } from '../transcript/extractor.js';
import { storeSnapshot, writeLatestMd, loadLatestSnapshot, getSnapshotsDir } from './storage.js';
import { compressToMarkdown } from './compress.js';
import { writeTrails } from '../trails/writer.js';
import { loadState, saveState, updateSnapshotTime, incrementSnapshotCount } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import { appendToRegistry } from '../registry.js';
import type { Snapshot, SnapshotTrigger } from '../types.js';
import type { ContextUsage } from '../threshold/token-usage.js';

export interface CaptureOptions {
  trigger: SnapshotTrigger;
  transcriptPath: string;
  cwd: string;
  sessionId?: string;
  contextUsage?: ContextUsage;
}

/**
 * Snapshot capture pipeline (v0.3 — file tracking only):
 * 1. Parse transcript
 * 2. Extract file changes + tool usage (the parts that actually work)
 * 3. Build snapshot object
 * 4. Store snapshot JSON + write LATEST.md + trail files
 * 5. Update state
 *
 * Intent, decisions, and progress are NOT extracted from transcripts —
 * regex can't do semantic extraction reliably. Instead, Claude writes
 * bookmark.context.md directly after the token hook requests a handoff or the
 * Stop hook blocks for one.
 * This pipeline provides supplementary file tracking data.
 */
export async function captureSnapshot(options: CaptureOptions): Promise<Snapshot> {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadState(storagePath);

  // 1. Parse transcript
  const { entries } = parseTranscript(options.transcriptPath);

  // 2. Extract file changes + tool usage only (working parts of extractor)
  // Intent, decisions, and progress are NOT extracted — Claude writes the handoff.
  const extraction = extractFilesAndTools(entries, { projectPath: options.cwd });

  // 3. Build snapshot
  const snapshotId = generateSnapshotId();
  const priorSnapshot = loadLatestSnapshot(storagePath);

  const snapshot: Snapshot = {
    snapshot_id: snapshotId,
    timestamp: Date.now(),
    session_id: options.sessionId ?? state.session_id ?? 'unknown',
    project_path: options.cwd,
    trigger: options.trigger,
    compaction_cycle: state.compaction_count,
    files_changed: extraction.files_changed,
    tools_summary: extraction.tools_summary,
    prior_snapshot_id: priorSnapshot?.snapshot_id,
    context_remaining_pct: options.contextUsage?.remainingFraction,
    context_used_pct: options.contextUsage?.usedFraction,
    token_estimate: options.contextUsage?.usedTokens,
    context_limit_tokens: options.contextUsage?.contextLimitTokens,
    model: options.contextUsage?.model,
  };

  // 4. Skip empty snapshots — don't write JSON/index for 0-file non-manual captures
  // This prevents accumulation of empty session_end snapshots
  const hasContent =
    snapshot.files_changed.length > 0 ||
    snapshot.trigger === 'manual' ||
    snapshot.trigger === 'token_threshold';

  if (hasContent) {
    storeSnapshot(storagePath, snapshot);
    const markdown = compressToMarkdown(snapshot);
    writeLatestMd(storagePath, markdown);
    writeTrails(storagePath, snapshot);

    const canonicalFile = join(getSnapshotsDir(storagePath), `${snapshot.snapshot_id}.json`);
    appendToRegistry(snapshot, canonicalFile);
  }

  // 6. Update state + increment snapshot counter
  const updatedState = updateSnapshotTime(state);
  const finalState = incrementSnapshotCount(updatedState);
  saveState(storagePath, finalState);

  return snapshot;
}

function generateSnapshotId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `SNAP_${date}_${time}`;
}
