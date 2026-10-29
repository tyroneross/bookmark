import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { lookupCatalogContextWindow } from './model-catalog.js';

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
// Source for model context limits:
// https://platform.claude.com/docs/en/build-with-claude/context-windows

interface RawUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

/** transcript_usage: measured from the host transcript; turn_estimate: turns × tokens-per-turn (estimated). */
export type UsageSource = 'transcript_usage' | 'turn_estimate';

export interface ContextUsage {
  status: 'measured';
  model: string;
  usedTokens: number;
  contextLimitTokens: number;
  usedFraction: number;
  remainingFraction: number;
  source: UsageSource;
  /** True when usedTokens is a heuristic, not a host-reported count. */
  estimated?: boolean;
}

export interface UnknownContextLimitUsage {
  status: 'unknown_context_limit';
  model: string;
  usedTokens: number;
  source: UsageSource;
  estimated?: boolean;
}

export type ContextUsageObservation = ContextUsage | UnknownContextLimitUsage;

/**
 * Context window for a model, in the order of docs/research/2026-10-28 §10:
 *   1. explicit override (`BOOKMARK_CONTEXT_LIMIT` / `contextLimitTokens`)
 *   2. window the host reported in its transcript or hook payload
 *   3. cached models.dev catalog (`bookmark catalog refresh`; never fetched from a hook)
 *   4. built-in table (`builtInContextLimit`)
 *   5. null — unknown; Bookmark asks for a verified limit instead of guessing.
 */
export function resolveContextWindow(
  model: string,
  options: { override?: number; reported?: number; catalogPath?: string } = {}
): number | null {
  if (isPositive(options.override)) return options.override;
  if (isPositive(options.reported)) return options.reported;
  const fromCatalog = model ? lookupCatalogContextWindow(normalizeModelId(model), options.catalogPath) : null;
  if (fromCatalog !== null) return fromCatalog;
  return builtInContextLimit(model);
}

/** Back-compat wrapper: override, then catalog, then built-in table. */
export function resolveContextLimit(model: string, override?: number): number | null {
  return resolveContextWindow(model, { override });
}

/**
 * Offline fallback table — the only place model window sizes are written down.
 * Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
 */
function builtInContextLimit(model: string): number | null {
  const normalized = normalizeModelId(model);
  const hasOneMillionContext = [
    /^claude-(?:opus|sonnet|fable|mythos)-5(?:-|$)/,
    /^claude-opus-4-(?:6|7|8)(?:-|$)/,
    /^claude-sonnet-4-6(?:-|$)/,
    /^claude-mythos-preview(?:-|$)/,
  ].some(pattern => pattern.test(normalized));

  if (hasOneMillionContext) return 1_000_000;

  const hasTwoHundredThousandContext = [
    /^claude-(?:opus|sonnet|haiku)-4-5(?:-|$)/,
  ].some(pattern => pattern.test(normalized));

  return hasTwoHundredThousandContext ? 200_000 : null;
}

/**
 * Read only the transcript tail and return the latest assistant usage record.
 * When `sessionId` is given, records stamped with a different `sessionId`
 * are skipped so one session never measures another's usage.
 */
export function readLatestContextUsage(
  transcriptPath: string,
  contextLimitOverride?: number,
  pendingPrompt = '',
  sessionId?: string
): ContextUsageObservation | null {
  const lines = readTailLines(transcriptPath);
  if (!lines) return null;
  try {
    // Codex rollouts: the newest token_count event carries usage and the
    // model's own context window; turn_context records carry the model name.
    // Collect the newest token_count first, then the model from an older
    // turn_context, and only then resolve the window (M4: never "codex").
    let codexUsage: CodexTokenCount | null = null;
    const finishCodex = (model: string | undefined): ContextUsageObservation => {
      const name = model ?? 'codex';
      const window = resolveContextWindow(model ?? '', { override: contextLimitOverride, reported: codexUsage!.reportedWindow });
      return observation(name, codexUsage!.usedTokens, window, 'transcript_usage', false);
    };
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;

      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type === 'event_msg' || record.type === 'turn_context') {
          const payload = isRecord(record.payload) ? record.payload : null;
          if (!payload) continue;
          if (record.type === 'turn_context' && codexUsage && typeof payload.model === 'string') {
            return finishCodex(payload.model);
          }
          if (record.type === 'event_msg' && payload.type === 'token_count' && !codexUsage) {
            codexUsage = readCodexTokenCount(payload, pendingPrompt);
          }
          continue;
        }
        if (codexUsage) continue;
        if (typeof record.type === 'string' && record.type !== 'assistant') continue;
        if (sessionId && typeof record.sessionId === 'string' && record.sessionId !== sessionId) continue;
        const message = isRecord(record.message) ? record.message : record;
        const usage = isRecord(message.usage) ? message.usage as RawUsage : null;
        const model = typeof message.model === 'string' ? message.model : null;
        if (!usage || !model || model === '<synthetic>') continue;

        const inputTokens = tokenCount(usage.input_tokens);
        const cacheCreationTokens = tokenCount(usage.cache_creation_input_tokens);
        const cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
        const outputTokens = tokenCount(usage.output_tokens);
        const promptEstimate = pendingPrompt
          ? Math.ceil(Buffer.byteLength(pendingPrompt, 'utf8') / 4)
          : 0;
        const usedTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens + promptEstimate;
        if (usedTokens <= 0) continue;

        const contextLimitTokens = resolveContextLimit(model, contextLimitOverride);
        if (contextLimitTokens === null) {
          return {
            status: 'unknown_context_limit',
            model,
            usedTokens,
            source: 'transcript_usage',
          };
        }

        const usedFraction = Math.min(usedTokens / contextLimitTokens, 1);
        return {
          status: 'measured',
          model,
          usedTokens,
          contextLimitTokens,
          usedFraction,
          remainingFraction: Math.max(0, 1 - usedFraction),
          source: 'transcript_usage',
        };
      } catch {
        // Skip malformed or partial JSONL lines.
      }
    }
    if (codexUsage) return finishCodex(undefined);
  } catch {
    return null;
  }

  return null;
}

/** Last ≤4 MiB of a JSONL file, split into lines (a partial first line is dropped). Null if missing/empty. */
function readTailLines(path: string): string[] | null {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    // Regular files only: opening a FIFO would block the hook.
    if (!statSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const bytesToRead = Math.min(size, MAX_TAIL_BYTES);
    const start = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function observation(
  model: string,
  usedTokens: number,
  contextLimitTokens: number | null,
  source: UsageSource,
  estimated: boolean
): ContextUsageObservation {
  const extra = estimated ? { estimated: true } : {};
  if (contextLimitTokens === null) {
    return { status: 'unknown_context_limit', model, usedTokens, source, ...extra };
  }
  const usedFraction = Math.min(usedTokens / contextLimitTokens, 1);
  return {
    status: 'measured',
    model,
    usedTokens,
    contextLimitTokens,
    usedFraction,
    remainingFraction: Math.max(0, 1 - usedFraction),
    source,
    ...extra,
  };
}

/**
 * Gemini CLI session records (`~/.gemini/tmp/<project_hash>/chats/`). The docs
 * say chats record token usage but publish no schema [INFERRED]: this accepts a
 * `tokens` object ({input, output, cached, thoughts, tool, total}) or the Gemini
 * API `usageMetadata` ({promptTokenCount, candidatesTokenCount, ...}) on the
 * record or its `message`, with the model in `model`. Cached tokens are already
 * inside the input/prompt count, so they are not added again. No window is
 * recorded, so the window comes from override → catalog → table.
 */
export function readGeminiContextUsage(
  transcriptPath: string,
  contextLimitOverride?: number,
  pendingPrompt = '',
  sessionId?: string
): ContextUsageObservation | null {
  const lines = readTailLines(transcriptPath);
  if (!lines) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (sessionId && typeof record.sessionId === 'string' && record.sessionId !== sessionId) continue;
      const message = isRecord(record.message) ? record.message : record;
      const model = typeof message.model === 'string' ? message.model
        : typeof record.model === 'string' ? record.model : null;
      let usedTokens = 0;
      if (isRecord(message.tokens)) {
        usedTokens = tokenCount(message.tokens.input) + tokenCount(message.tokens.output);
      } else if (isRecord(message.usageMetadata)) {
        usedTokens = tokenCount(message.usageMetadata.promptTokenCount) + tokenCount(message.usageMetadata.candidatesTokenCount);
      }
      if (!model || usedTokens <= 0) continue;
      usedTokens += promptEstimateTokens(pendingPrompt);
      return observation(model, usedTokens, resolveContextWindow(model, { override: contextLimitOverride }), 'transcript_usage', false);
    } catch {
      // Skip malformed or partial JSONL lines.
    }
  }
  return null;
}

/** Default tokens per user turn for the turn-count estimate (`BOOKMARK_TOKENS_PER_TURN` overrides). */
export const DEFAULT_TOKENS_PER_TURN = 4000;

/**
 * For hosts whose transcript format is undocumented (Copilot CLI): count user
 * turns and multiply by a per-turn budget. Always labelled `estimated`. A turn
 * is a JSONL record whose `type` contains "user" or whose `role` is "user"
 * [INFERRED]. The result never drops below `previousTokens`. The window comes from override → catalog (if the model is known)
 * → table; with none, the result is `unknown_context_limit`.
 */
export function estimateContextUsageFromTurns(
  transcriptPath: string,
  options: { override?: number; model?: string; tokensPerTurn?: number; previousTokens?: number } = {}
): ContextUsageObservation | null {
  const lines = readTailLines(transcriptPath);
  if (!lines) return null;
  let turns = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const data = isRecord(record.data) ? record.data : record;
      const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
      const role = typeof data.role === 'string' ? data.role.toLowerCase() : '';
      if (role === 'user' || /(^|[._])user([._]|$)/.test(type)) turns += 1;
    } catch {
      // Skip malformed or partial JSONL lines.
    }
  }
  const perTurn = isPositive(options.tokensPerTurn) ? options.tokensPerTurn : DEFAULT_TOKENS_PER_TURN;
  // Only the 4 MiB tail is read, so early turns drop out as the file grows;
  // the caller's previous estimate for this session keeps the value monotonic.
  const usedTokens = Math.max(turns * perTurn, isPositive(options.previousTokens) ? options.previousTokens : 0);
  if (usedTokens === 0) return null;
  const model = options.model ?? 'unknown';
  const window = resolveContextWindow(options.model ?? '', { override: options.override });
  return observation(model, usedTokens, window, 'turn_estimate', true);
}

function promptEstimateTokens(pendingPrompt: string): number {
  return pendingPrompt ? Math.ceil(Buffer.byteLength(pendingPrompt, 'utf8') / 4) : 0;
}

function isPositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Codex `token_count` payload: info.last_token_usage is the latest request,
 * whose input_tokens already include cached input; info.model_context_window
 * is the window Codex itself uses for the active model.
 */
interface CodexTokenCount {
  usedTokens: number;
  reportedWindow: number;
}

function readCodexTokenCount(payload: Record<string, unknown>, pendingPrompt: string): CodexTokenCount | null {
  const info = isRecord(payload.info) ? payload.info : null;
  const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
  if (!info || !last) return null;
  const usedTokens = tokenCount(last.input_tokens) + tokenCount(last.output_tokens) + promptEstimateTokens(pendingPrompt);
  if (usedTokens <= 0) return null;
  return { usedTokens, reportedWindow: tokenCount(info.model_context_window) };
}

export function newlyCrossedThresholds(
  usedFraction: number,
  configuredThresholds: number[],
  alreadyTriggered: number[] = []
): number[] {
  const handled = new Set(alreadyTriggered.map(value => Number(value.toFixed(4))));
  return [...configuredThresholds]
    .filter(value => Number.isFinite(value) && value > 0 && value < 1)
    .sort((a, b) => a - b)
    .filter(value => usedFraction >= value && !handled.has(Number(value.toFixed(4))));
}

/** Re-arm alerts only after a lower usage record proves a new context cycle. */
export function handledThresholdsForUsage(
  usedFraction: number,
  configuredThresholds: number[],
  alreadyTriggered: number[] = []
): number[] {
  const lowestThreshold = Math.min(...configuredThresholds);
  return usedFraction < lowestThreshold ? [] : alreadyTriggered;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/^anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@(\d{8})$/, '-$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
