import { parseTranscript } from '../transcript/parser.js';
import { estimateFromTranscript } from '../transcript/estimator.js';
import { extractFromEntries } from '../transcript/extractor.js';
import { storeSnapshot, writeLatestMd, loadLatestSnapshot } from './storage.js';
import { compressToMarkdown } from './compress.js';
import { loadState, saveState, updateSnapshotTime } from '../threshold/state.js';
import { loadConfig, getStoragePath } from '../config.js';
import type { Snapshot, SnapshotTrigger } from '../types.js';

export interface CaptureOptions {
  trigger: SnapshotTrigger;
  transcriptPath: string;
  cwd: string;
  sessionId?: string;
  smart?: boolean;
}

/**
 * Full snapshot capture pipeline:
 * 1. Parse transcript
 * 2. Estimate token usage
 * 3. Extract decisions/status/files/errors
 * 4. Optionally enhance with LLM (--smart)
 * 5. Build snapshot object
 * 6. Store snapshot JSON
 * 7. Generate and write LATEST.md
 * 8. Update state
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

  // 3. Extract structured content
  let extraction = extractFromEntries(entries);

  // 4. Optional LLM enhancement
  if (options.smart ?? config.smartDefault) {
    extraction = await enhanceWithLLM(extraction, entries);
  }

  // 5. Build snapshot
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
    current_status: extraction.current_status,
    decisions: extraction.decisions,
    open_items: extraction.open_items,
    unknowns: extraction.unknowns,
    files_changed: extraction.files_changed,
    errors_encountered: extraction.errors_encountered,
    tools_summary: extraction.tools_summary,
    prior_snapshot_id: priorSnapshot?.snapshot_id,
  };

  // 6. Store snapshot
  storeSnapshot(storagePath, snapshot);

  // 7. Generate LATEST.md
  const markdown = compressToMarkdown(snapshot);
  writeLatestMd(storagePath, markdown);

  // 8. Update state
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

/**
 * Enhance extraction with Claude Haiku for higher-quality summaries.
 * Falls back to original extraction if SDK not available or API key missing.
 */
async function enhanceWithLLM(
  extraction: ReturnType<typeof extractFromEntries>,
  entries: import('../types.js').TranscriptEntry[]
): Promise<ReturnType<typeof extractFromEntries>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return extraction;

  try {
    // Dynamic import — @anthropic-ai/sdk is an optional dependency
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Build a compressed transcript excerpt (last ~2000 tokens worth)
    const recentEntries = entries.slice(-50); // Last 50 entries
    const transcript = recentEntries
      .filter(e => e.type === 'assistant' || e.type === 'user')
      .map(e => `[${e.type}]: ${typeof e.content === 'string' ? e.content.slice(0, 200) : ''}`)
      .join('\n')
      .slice(-4000);

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Analyze this coding session transcript and extract:
1. Key decisions made (with brief rationale)
2. Current status (1-2 sentences)
3. Open items/TODOs (with priority: high/medium/low)
4. Unknowns or blockers

Transcript excerpt:
${transcript}

Respond in JSON format:
{
  "current_status": "...",
  "decisions": [{"description": "...", "rationale": "..."}],
  "open_items": [{"description": "...", "priority": "high|medium|low"}],
  "unknowns": ["..."]
}`,
      }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const enhanced = JSON.parse(jsonMatch[0]);
      return {
        ...extraction,
        current_status: enhanced.current_status ?? extraction.current_status,
        decisions: enhanced.decisions?.length ? enhanced.decisions : extraction.decisions,
        open_items: enhanced.open_items?.length ? enhanced.open_items : extraction.open_items,
        unknowns: enhanced.unknowns?.length ? enhanced.unknowns : extraction.unknowns,
      };
    }
  } catch {
    // Fall back silently to pattern-based extraction
  }

  return extraction;
}
