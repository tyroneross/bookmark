import { readFileSync, existsSync, statSync } from 'node:fs';
import type { TranscriptEntry, TranscriptContent } from '../types.js';

export interface ParseOptions {
  startOffset?: number; // Byte offset to start reading from
}

export interface ParseResult {
  entries: TranscriptEntry[];
  bytesRead: number;
  totalBytes: number;
}

/**
 * Stream-parse a JSONL transcript file.
 * Each line is a JSON object representing a message or tool call.
 * Supports reading from a byte offset for incremental parsing.
 */
export function parseTranscript(transcriptPath: string, options?: ParseOptions): ParseResult {
  if (!existsSync(transcriptPath)) {
    return { entries: [], bytesRead: 0, totalBytes: 0 };
  }

  const startOffset = options?.startOffset ?? 0;
  const stat = statSync(transcriptPath);
  const totalBytes = stat.size;

  if (startOffset >= totalBytes) {
    return { entries: [], bytesRead: totalBytes, totalBytes };
  }

  const raw = readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n');

  const entries: TranscriptEntry[] = [];
  let currentByteOffset = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + '\n', 'utf-8');

    if (currentByteOffset < startOffset) {
      currentByteOffset += lineBytes;
      continue;
    }

    currentByteOffset += lineBytes;

    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      const entry = normalizeEntry(parsed);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    entries,
    bytesRead: totalBytes,
    totalBytes,
  };
}

/**
 * Normalize various transcript JSON formats into a consistent TranscriptEntry.
 */
function normalizeEntry(raw: Record<string, unknown>): TranscriptEntry | null {
  // Handle different transcript formats
  const type = inferType(raw);
  if (!type) return null;

  const content = extractTextContent(raw);

  return {
    type,
    timestamp: (raw.timestamp as number) ?? undefined,
    content,
    tool_name: (raw.tool_name as string) ?? (raw.name as string) ?? undefined,
    tool_input: (raw.tool_input as Record<string, unknown>) ?? (raw.input as Record<string, unknown>) ?? undefined,
    session_id: (raw.session_id as string) ?? undefined,
  };
}

function inferType(raw: Record<string, unknown>): TranscriptEntry['type'] | null {
  if (raw.type && typeof raw.type === 'string') {
    const t = raw.type.toLowerCase();
    if (t === 'user' || t === 'human') return 'user';
    if (t === 'assistant' || t === 'ai') return 'assistant';
    if (t === 'tool_use') return 'tool_use';
    if (t === 'tool_result') return 'tool_result';
    if (t === 'system') return 'system';
  }

  // Infer from role field
  if (raw.role && typeof raw.role === 'string') {
    const r = raw.role.toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant') return 'assistant';
    if (r === 'system') return 'system';
  }

  // Infer from content structure
  if (raw.tool_name || raw.name) return 'tool_use';
  if (raw.tool_use_id) return 'tool_result';

  return null;
}

/**
 * Extract text content from various message formats.
 */
function extractTextContent(raw: Record<string, unknown>): string {
  const content = raw.content ?? raw.text ?? raw.message ?? '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return (content as TranscriptContent[])
      .map(block => {
        if (typeof block === 'string') return block;
        if (block.text) return block.text;
        if (block.content && typeof block.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}
