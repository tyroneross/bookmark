import { statSync } from 'node:fs';
import { withFileLock } from '../util/file-lock.js';
import { join } from 'node:path';
import { parseTranscript } from '../transcript/parser.js';
import { extractFilesAndTools } from '../transcript/extractor.js';
import { storeSnapshot, writeLatestMd, loadLatestSnapshot, getSnapshotsDir, generateSnapshotId } from './storage.js';
import { compressToMarkdown } from './compress.js';
import { writeTrails } from '../trails/writer.js';
import { loadSessionState, saveSessionState, updateSnapshotTime, incrementSnapshotCount } from '../threshold/state.js';
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
  return withFileLock(join(storagePath, "capture"), () => {
    const state = loadSessionState(storagePath, options.sessionId);
    const sessionId = options.sessionId ?? state.session_id ?? 'unknown';
    const priorSnapshot = loadLatestSnapshot(storagePath);
    const stat = statSync(options.transcriptPath);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const canResume = priorSnapshot?.transcript_source === options.transcriptPath
      && priorSnapshot.session_id === sessionId
      && priorSnapshot.transcript_identity === identity
      && (priorSnapshot.transcript_offset ?? Infinity) <= stat.size;
    if (canResume && priorSnapshot!.transcript_offset === stat.size
        && (options.trigger === 'session_end' || options.trigger === 'time_interval')) return priorSnapshot!;
    const offset = canResume ? priorSnapshot!.transcript_offset : 0;

    // 1. Parse transcript
    const { entries, bytesRead } = parseTranscript(options.transcriptPath, { startOffset: offset });

    // 2. Extract file changes + tool usage only (working parts of extractor)
    // Intent, decisions, and progress are NOT extracted — Claude writes the handoff.
    const extraction = extractFilesAndTools(entries, { projectPath: options.cwd });

    // 3. Build snapshot
    const snapshotId = generateSnapshotId();
    if (canResume && priorSnapshot) {
      const files = new Map(priorSnapshot.files_changed.map(f => [f.path, { ...f }]));
      for (const file of extraction.files_changed) {
        const old = files.get(file.path);
        files.set(file.path, old ? { ...file,
          operations: [...new Set([...old.operations, ...file.operations])],
          lines_changed: (old.lines_changed || 0) + (file.lines_changed || 0),
          summary: [...new Set([
            ...(old.summary?.split(', ') ?? []),
            ...(file.summary?.split(', ') ?? []),
          ])].join(', ') || undefined,
        } : file);
      }
      extraction.files_changed = [...files.values()];
      for (const [tool, count] of Object.entries(priorSnapshot.tools_summary)) {
        extraction.tools_summary[tool] = (extraction.tools_summary[tool] || 0) + count;
      }
    }

    const snapshot: Snapshot = {
      snapshot_id: snapshotId,
      timestamp: Date.now(),
      session_id: sessionId,
      project_path: options.cwd,
      trigger: options.trigger,
      compaction_cycle: state.compaction_count,
      files_changed: extraction.files_changed,
      tools_summary: extraction.tools_summary,
      prior_snapshot_id: priorSnapshot?.snapshot_id,
      transcript_source: options.transcriptPath, transcript_identity: identity, transcript_offset: bytesRead,
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
    saveSessionState(storagePath, options.sessionId, finalState);

    return snapshot;
  });
}
