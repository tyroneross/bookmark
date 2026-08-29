import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
// Source for model context limits:
// https://platform.claude.com/docs/en/build-with-claude/context-windows

interface RawUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
}

export interface ContextUsage {
  status: 'measured';
  model: string;
  usedTokens: number;
  contextLimitTokens: number;
  usedFraction: number;
  remainingFraction: number;
  source: 'transcript_usage';
}

export interface UnknownContextLimitUsage {
  status: 'unknown_context_limit';
  model: string;
  usedTokens: number;
  source: 'transcript_usage';
}

export type ContextUsageObservation = ContextUsage | UnknownContextLimitUsage;

/**
 * Resolve the context limit for models observed in Claude Code transcripts.
 * An explicit override wins so users can handle provider/model changes without
 * waiting for a Bookmark release. Unknown models return null so Bookmark can
 * ask for a verified limit instead of guessing.
 */
export function resolveContextLimit(model: string, override?: number): number | null {
  if (override && Number.isFinite(override) && override > 0) return override;

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

/** Read only the transcript tail and return the latest assistant usage record. */
export function readLatestContextUsage(
  transcriptPath: string,
  contextLimitOverride?: number,
  pendingPrompt = ''
): ContextUsageObservation | null {
  if (!existsSync(transcriptPath)) return null;

  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
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

    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;

      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (typeof record.type === 'string' && record.type !== 'assistant') continue;
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
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  return null;
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
