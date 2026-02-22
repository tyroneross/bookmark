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

  // 3. Extract structural content (files, tools, sentiment — always reliable)
  let extraction = extractFromEntries(entries, { projectPath: options.cwd });

  // 4. LLM extraction for intent + progress (default on, uses claude CLI)
  // Falls back to pattern matching if claude CLI unavailable
  const skipLLM = options.smart === false;
  if (!skipLLM) {
    extraction = await extractWithLLM(extraction, entries);
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

  // 6. Store snapshot
  storeSnapshot(storagePath, snapshot);

  // 7. Generate LATEST.md — only update if snapshot has actual content
  const hasContent = snapshot.files_changed.length > 0
    || snapshot.decisions.length > 0
    || snapshot.open_items.length > 0
    || (snapshot.intent !== 'Unknown' && snapshot.intent !== undefined);
  if (hasContent || snapshot.trigger === 'manual') {
    const markdown = compressToMarkdown(snapshot);
    writeLatestMd(storagePath, markdown);
  }

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
 * Extract intent, progress, decisions, and open items using Claude CLI.
 * Uses `claude -p` — no API key needed, uses the user's existing Claude Code auth.
 * Falls back to ANTHROPIC_API_KEY direct API call, then to pattern matching.
 *
 * ROI: spends ~200 tokens to save 10K-100K tokens of context that would be lost.
 */
async function extractWithLLM(
  extraction: ReturnType<typeof extractFromEntries>,
  entries: import('../types.js').TranscriptEntry[]
): Promise<ReturnType<typeof extractFromEntries>> {
  // Build a compressed transcript excerpt — user + assistant messages only
  const recentEntries = entries.slice(-60);
  const transcript = recentEntries
    .filter(e => e.type === 'assistant' || e.type === 'user')
    .map(e => `[${e.type}]: ${typeof e.content === 'string' ? e.content.slice(0, 300) : ''}`)
    .join('\n')
    .slice(-5000);

  const prompt = `You are a context extraction tool. Analyze this coding session transcript and respond ONLY with a JSON object. No markdown, no explanation.

Extract:
1. intent: What is the user trying to accomplish? (1 sentence)
2. progress: How far along are they? What's done vs remaining? (1-2 sentences)
3. current_status: What was happening most recently? (1 sentence)
4. decisions: Key technical decisions made (max 4, each 1 sentence)
5. open_items: Remaining work items (max 4, with priority high/medium/low)

Transcript:
${transcript}

JSON response:`;

  // Use ANTHROPIC_API_KEY with Haiku (~$0.001/snapshot)
  // Most Claude Code users have this set. Clean, no hook recursion.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const parsed = parseLLMResponse(text);
      if (parsed) return { ...extraction, ...parsed };
    } catch {
      // API call failed — fall back to pattern matching
    }
  }

  // Fallback: pattern matching (already in extraction)
  return extraction;
}

function parseLLMResponse(raw: string): Partial<ReturnType<typeof extractFromEntries>> | null {
  try {
    // Handle claude CLI JSON output format (has a result field)
    let text = raw;
    try {
      const cliOutput = JSON.parse(raw);
      if (cliOutput.result) text = cliOutput.result;
      else if (typeof cliOutput === 'string') text = cliOutput;
    } catch {
      // Not JSON wrapper, use raw text
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const data = JSON.parse(jsonMatch[0]);
    const result: Partial<ReturnType<typeof extractFromEntries>> = {};

    if (data.intent) result.intent = data.intent;
    if (data.progress) result.progress = data.progress;
    if (data.current_status) result.current_status = data.current_status;
    if (data.decisions?.length) {
      result.decisions = data.decisions.map((d: { description?: string; rationale?: string }) => ({
        description: d.description ?? d,
        rationale: d.rationale,
      }));
    }
    if (data.open_items?.length) {
      result.open_items = data.open_items.map((item: { description?: string; priority?: string }) => ({
        description: item.description ?? item,
        priority: item.priority ?? 'medium',
      }));
    }

    return result;
  } catch {
    return null;
  }
}
