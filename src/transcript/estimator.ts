import { existsSync, statSync } from 'node:fs';
import type { TokenEstimate, TranscriptEntry } from '../types.js';
import { parseTranscript } from './parser.js';

const DEFAULT_CONTEXT_LIMIT = 200_000;
const CHARS_PER_TOKEN = 4;

export interface EstimateOptions {
  contextLimit?: number;
  charsPerToken?: number;
  startOffset?: number;
}

/**
 * Estimate token usage from a transcript file.
 * Uses a simple chars/4 heuristic — accurate enough for threshold comparison.
 */
export function estimateFromTranscript(
  transcriptPath: string,
  options?: EstimateOptions
): TokenEstimate {
  const contextLimit = options?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const charsPerToken = options?.charsPerToken ?? CHARS_PER_TOKEN;

  if (!existsSync(transcriptPath)) {
    return emptyEstimate(contextLimit);
  }

  const { entries } = parseTranscript(transcriptPath, {
    startOffset: options?.startOffset,
  });

  let userChars = 0;
  let assistantChars = 0;
  let toolChars = 0;
  let systemChars = 0;

  for (const entry of entries) {
    const text = typeof entry.content === 'string' ? entry.content : '';
    const len = text.length;

    switch (entry.type) {
      case 'user':
        userChars += len;
        break;
      case 'assistant':
        assistantChars += len;
        break;
      case 'tool_use':
      case 'tool_result':
        toolChars += len;
        break;
      case 'system':
        systemChars += len;
        break;
    }
  }

  const totalChars = userChars + assistantChars + toolChars + systemChars;
  const totalTokens = Math.ceil(totalChars / charsPerToken);
  const userTokens = Math.ceil(userChars / charsPerToken);
  const assistantTokens = Math.ceil(assistantChars / charsPerToken);
  const toolTokens = Math.ceil(toolChars / charsPerToken);
  const systemTokens = Math.ceil(systemChars / charsPerToken);

  const remainingTokens = Math.max(0, contextLimit - totalTokens);
  const remainingPct = contextLimit > 0 ? remainingTokens / contextLimit : 1;

  return {
    total_tokens: totalTokens,
    message_count: entries.length,
    user_tokens: userTokens,
    assistant_tokens: assistantTokens,
    tool_tokens: toolTokens,
    system_tokens: systemTokens,
    context_limit: contextLimit,
    remaining_pct: Math.round(remainingPct * 100) / 100,
    remaining_tokens: remainingTokens,
  };
}

/**
 * Quick file-size-based estimation without parsing.
 * Much faster for threshold checks — reads only file metadata.
 */
export function quickEstimate(
  transcriptPath: string,
  contextLimit = DEFAULT_CONTEXT_LIMIT,
  charsPerToken = CHARS_PER_TOKEN
): { estimatedTokens: number; remainingPct: number } {
  if (!existsSync(transcriptPath)) {
    return { estimatedTokens: 0, remainingPct: 1 };
  }

  try {
    const stat = statSync(transcriptPath);
    // File size in bytes ≈ chars for ASCII-heavy content
    // JSON overhead adds ~30%, so adjust
    const estimatedContentChars = stat.size * 0.7;
    const estimatedTokens = Math.ceil(estimatedContentChars / charsPerToken);
    const remainingPct = Math.max(0, Math.round((1 - estimatedTokens / contextLimit) * 100) / 100);

    return { estimatedTokens, remainingPct };
  } catch {
    return { estimatedTokens: 0, remainingPct: 1 };
  }
}

function emptyEstimate(contextLimit: number): TokenEstimate {
  return {
    total_tokens: 0,
    message_count: 0,
    user_tokens: 0,
    assistant_tokens: 0,
    tool_tokens: 0,
    system_tokens: 0,
    context_limit: contextLimit,
    remaining_pct: 1,
    remaining_tokens: contextLimit,
  };
}
