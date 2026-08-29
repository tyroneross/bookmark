import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handledThresholdsForUsage,
  newlyCrossedThresholds,
  readLatestContextUsage,
  resolveContextLimit,
} from './token-usage.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveContextLimit', () => {
  it('uses verified limits for documented model families', () => {
    expect(resolveContextLimit('claude-opus-5')).toBe(1_000_000);
    expect(resolveContextLimit('claude-sonnet-4-6')).toBe(1_000_000);
    expect(resolveContextLimit('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveContextLimit('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000);
    expect(resolveContextLimit('future-unknown-model')).toBeNull();
  });

  it('honors an explicit override', () => {
    expect(resolveContextLimit('future-unknown-model', 500_000)).toBe(500_000);
  });
});

describe('readLatestContextUsage', () => {
  it('adds input, cache, output, and pending-prompt tokens from the latest assistant record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookmark-token-'));
    tempDirs.push(dir);
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, [
      JSON.stringify({ type: 'assistant', message: {
        model: 'claude-haiku-4-5-20251001',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 20,
          output_tokens: 10,
        },
      } }),
      JSON.stringify({ type: 'user', message: { content: 'next' } }),
      JSON.stringify({ type: 'assistant', message: {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 100_000,
          cache_creation_input_tokens: 200_000,
          cache_read_input_tokens: 440_000,
          output_tokens: 10_000,
        },
      } }),
      JSON.stringify({ type: 'system', message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 999_999 },
      } }),
    ].join('\n'));

    const usage = readLatestContextUsage(transcript, undefined, 'test');
    expect(usage).toMatchObject({
      status: 'measured',
      model: 'claude-opus-5',
      usedTokens: 750_001,
      contextLimitTokens: 1_000_000,
      usedFraction: 0.750001,
      source: 'transcript_usage',
    });
  });

  it('reports measured tokens without inventing a limit for an unknown model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookmark-token-'));
    tempDirs.push(dir);
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: {
      model: 'future-unknown-model',
      usage: { input_tokens: 12_345 },
    } }));

    expect(readLatestContextUsage(transcript)).toEqual({
      status: 'unknown_context_limit',
      model: 'future-unknown-model',
      usedTokens: 12_345,
      source: 'transcript_usage',
    });
  });

  it('returns null when the transcript has no measured usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bookmark-token-'));
    tempDirs.push(dir);
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'hello' } }));
    expect(readLatestContextUsage(transcript)).toBeNull();
  });
});

describe('newlyCrossedThresholds', () => {
  it('returns each newly crossed threshold once', () => {
    expect(newlyCrossedThresholds(0.8, [0.75, 0.6], [0.6])).toEqual([0.75]);
    expect(newlyCrossedThresholds(0.8, [0.75], [0.75])).toEqual([]);
  });
});

describe('handledThresholdsForUsage', () => {
  it('keeps alerts handled while the stale pre-compaction usage remains high', () => {
    expect(handledThresholdsForUsage(0.8, [0.75], [0.75])).toEqual([0.75]);
  });

  it('re-arms alerts after post-compaction usage falls below the threshold', () => {
    expect(handledThresholdsForUsage(0.2, [0.75], [0.75])).toEqual([]);
  });
});
