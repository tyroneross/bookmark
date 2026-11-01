import { openSync, readSync, closeSync, existsSync, statSync } from 'node:fs';
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

  const fd = openSync(transcriptPath, 'r');
  const buffer = Buffer.alloc(totalBytes - startOffset);
  let loaded = 0;
  try {
    while (loaded < buffer.length) {
      const n = readSync(fd, buffer, loaded, buffer.length - loaded, startOffset + loaded);
      if (!n) break;
      loaded += n;
    }
  } finally { closeSync(fd); }
  const raw = buffer.subarray(0, loaded).toString('utf-8');
  const lines = raw.split('\n');

  const entries: TranscriptEntry[] = [];
  let currentByteOffset = startOffset;

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
      const normalized = normalizeEntry(parsed);
      if (normalized) {
        entries.push(normalized);
      }

      // Also extract individual tool_use blocks from assistant messages
      // Claude Code embeds tool calls inside message.content arrays
      const message = parsed.message as Record<string, unknown> | undefined;
      if (message?.content && Array.isArray(message.content)) {
        // Build a tool_use_id → tool_name lookup for resolving tool_result entries
        const toolIdToName = new Map<string, string>();
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolIdToName.set(block.id as string, block.name as string);
          }
        }

        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === 'tool_use' && block.name) {
            entries.push({
              type: 'tool_use',
              timestamp: (parsed.timestamp as number) ?? undefined,
              content: '',
              tool_name: block.name as string,
              tool_input: block.input as Record<string, unknown>,
              session_id: (parsed.sessionId as string) ?? undefined,
            });
          }
          if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as Array<Record<string, unknown>>)
                    .map(c => (c.text as string) ?? '')
                    .filter(Boolean)
                    .join('\n')
                : '';
            // Resolve tool_use_id to actual tool name
            const toolUseId = block.tool_use_id as string | undefined;
            const resolvedName = toolUseId ? toolIdToName.get(toolUseId) : undefined;
            entries.push({
              type: 'tool_result',
              timestamp: (parsed.timestamp as number) ?? undefined,
              content: resultContent,
              tool_name: resolvedName ?? toolUseId,
              session_id: (parsed.sessionId as string) ?? undefined,
            });
          }
        }
      }
    } catch {
      // Keep an incomplete final record for the next incremental read.
      if (currentByteOffset >= totalBytes && !raw.endsWith("\n")) currentByteOffset -= lineBytes;
    }
  }

  return {
    entries,
    bytesRead: Math.min(totalBytes, currentByteOffset),
    totalBytes,
  };
}

/**
 * Normalize various transcript JSON formats into a consistent TranscriptEntry.
 */
function normalizeEntry(raw: Record<string, unknown>): TranscriptEntry | null {
  if (raw.type === 'response_item' && raw.payload && typeof raw.payload === 'object') {
    const p = raw.payload as Record<string, unknown>;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input: Record<string, unknown> = {};
      if (p.type === 'custom_tool_call') input = { command: p.input };
      else {
        try { input = JSON.parse(String(p.arguments || '{}')); } catch { return null; }
      }
      return { type: 'tool_use', content: '', tool_name: String(p.name || ''), tool_input: input };
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      return { type: 'tool_result', content: String(p.output || '') };
    }
    if (p.type === 'message') raw = { ...p };
  }

  // Handle different transcript formats
  const type = inferType(raw);
  if (!type) return null;

  const content = extractTextContent(raw);

  // Claude Code JSONL nests message fields
  const message = raw.message as Record<string, unknown> | undefined;

  // Extract tool_use blocks from assistant message content arrays
  let toolName = (raw.tool_name as string) ?? (raw.name as string) ?? undefined;
  let toolInput = (raw.tool_input as Record<string, unknown>) ?? (raw.input as Record<string, unknown>) ?? undefined;

  if (!toolName && message?.content && Array.isArray(message.content)) {
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use') {
        toolName = block.name as string;
        toolInput = block.input as Record<string, unknown>;
        break;
      }
    }
  }

  return {
    type,
    timestamp: (raw.timestamp as number) ?? undefined,
    content,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: (raw.sessionId as string) ?? (raw.session_id as string) ?? undefined,
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
  // Claude Code JSONL nests content under message.content
  const message = raw.message as Record<string, unknown> | undefined;
  const content = raw.content ?? message?.content ?? raw.text ?? '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return (content as TranscriptContent[])
      .map(block => {
        if (typeof block === 'string') return block;
        if (block.text) return block.text;
        if (block.thinking) return block.thinking as string;
        if (block.content && typeof block.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}
