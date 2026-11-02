import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript } from './parser.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transcript delta byte boundaries', () => {
  it('retains an incomplete UTF-8 record and reads it once after completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'bookmark-parser-delta-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    const first = JSON.stringify({ type: 'user', content: 'café' }) + '\n';
    const second = Buffer.from(JSON.stringify({ type: 'user', content: '你好' }) + '\n');
    // Split inside a multibyte character while the producer is appending.
    const cut = second.indexOf(Buffer.from('好')) + 1;
    writeFileSync(path, Buffer.concat([Buffer.from(first), second.subarray(0, cut)]));
    const before = parseTranscript(path);
    expect(before.entries.map(e => e.content)).toEqual(['café']);
    expect(before.bytesRead).toBe(Buffer.byteLength(first));

    appendFileSync(path, second.subarray(cut));
    const after = parseTranscript(path, { startOffset: before.bytesRead });
    expect(after.entries.map(e => e.content)).toEqual(['你好']);
    expect(after.bytesRead).toBe(after.totalBytes);
    expect(parseTranscript(path, { startOffset: after.bytesRead }).entries).toEqual([]);
  });

  it('normalizes Codex function calls and custom patch calls in the delta', () => {
    const root = mkdtempSync(join(tmpdir(), 'bookmark-parser-codex-'));
    roots.push(root);
    const path = join(root, 'transcript.jsonl');
    const prefix = JSON.stringify({ type: 'user', content: 'before' }) + '\n';
    writeFileSync(path, prefix);
    for (const payload of [
      { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd' }) },
      { type: 'custom_tool_call', name: 'apply_patch', input: '*** Add File: a.ts\n+x' },
    ]) appendFileSync(path, JSON.stringify({ type: 'response_item', payload }) + '\n');
    const result = parseTranscript(path, { startOffset: Buffer.byteLength(prefix) });
    expect(result.entries).toMatchObject([
      { type: 'tool_use', tool_name: 'exec_command', tool_input: { cmd: 'pwd' } },
      { type: 'tool_use', tool_name: 'apply_patch', tool_input: { command: '*** Add File: a.ts\n+x' } },
    ]);
    expect(result.bytesRead).toBe(result.totalBytes);
  });
});
