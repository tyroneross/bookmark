import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdapter, getAdapter, resolveAdapter } from './adapter.js';
import { listHostIds, loadManifest, ROLES } from './manifest.js';
import { hookCommand, installHost, mergeHookConfig, planEntries, validateEventsWithCompat } from './install.js';
import {
  estimateContextUsageFromTurns,
  readGeminiContextUsage,
  resolveContextWindow,
} from '../threshold/token-usage.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(repoRoot, 'fixtures', 'hosts');
const temps: string[] = [];
const noCatalog = join(tmpdir(), 'bookmark-no-catalog-here.json');
process.env.BOOKMARK_MODEL_CATALOG = noCatalog;

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bookmark-host-'));
  temps.push(dir);
  return dir;
}

function payload(host: string, role: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtures, host, `${role}.json`), 'utf-8'));
}

/** A fake `rosslabs-lsp` that prints a compat registry listing `events` for `host`. */
function fakeCompat(dir: string, host: string, events: string[]): string {
  const bin = join(dir, 'fake-compat.sh');
  const doc = { records: [{ id: `agent-hooks.${host}.hook-config-location`, validity: { capabilities: ['support:yes', ...events.map(e => `event:${e}`)] } }] };
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(doc)}\nJSON\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('host manifests', () => {
  it('ships claude, codex, gemini and copilot with every mapped role valid', () => {
    expect(listHostIds()).toEqual(expect.arrayContaining(['claude', 'codex', 'copilot', 'gemini']));
    for (const id of listHostIds()) {
      const manifest = loadManifest(id)!;
      expect(manifest.id).toBe(id);
      for (const role of Object.keys(manifest.events)) expect(ROLES).toContain(role);
    }
  });

  it('plugin hooks/hooks.json uses exactly the Claude manifest events (no second copy of host facts drifts)', () => {
    const pluginHooks = JSON.parse(readFileSync(join(repoRoot, 'hooks', 'hooks.json'), 'utf-8')).hooks;
    expect(Object.keys(pluginHooks).sort()).toEqual(Object.values(loadManifest('claude')!.events).sort());
  });

  it('copilot has no prompt-time role: context-check degrades to stop', () => {
    const copilot = loadManifest('copilot')!;
    expect(copilot.events['context-check']).toBeUndefined();
    expect(copilot.capabilities.injectOnPrompt).toBe(false);
  });
});

describe('adapter selection', () => {
  it('an explicit --host wins over stdin sniffing', () => {
    const { adapter } = resolveAdapter(payload('codex', 'stop'), 'gemini', {});
    expect(adapter.id).toBe('gemini');
  });

  it('sniffs each fixture to its host when --host is absent', () => {
    expect(resolveAdapter(payload('codex', 'stop'), undefined, {}).adapter.id).toBe('codex');
    expect(resolveAdapter(payload('gemini', 'stop'), undefined, {}).adapter.id).toBe('gemini');
    expect(resolveAdapter(payload('copilot', 'stop'), undefined, {}).adapter.id).toBe('copilot');
    expect(resolveAdapter(payload('claude', 'stop'), undefined, {}).adapter.id).toBe('claude');
    expect(resolveAdapter(null, undefined, {}).adapter.id).toBe('claude');
  });

  it('an unknown --host warns and falls back to sniffing', () => {
    const result = resolveAdapter(payload('codex', 'stop'), 'nope', {});
    expect(result.adapter.id).toBe('codex');
    expect(result.warning).toContain('nope');
  });

  it('normalizes camelCase Copilot fields', () => {
    const ev = getAdapter('copilot')!.normalize({ ...payload('copilot', 'stop'), transcriptPath: '/x/events.jsonl' }, 'stop');
    expect(ev).toMatchObject({ host: 'copilot', role: 'stop', sessionId: 'fixture-copilot-0001', transcriptPath: '/x/events.jsonl', stopHookActive: false });
  });
});

describe('output dialects', () => {
  const ev = (host: string, role: 'restore' | 'context-check' | 'precompact' | 'stop') => getAdapter(host)!.normalize(payload(host, role === 'context-check' && host === 'copilot' ? 'stop' : role), role);

  it('restore: Claude/Codex print text, Gemini hookSpecificOutput, Copilot additionalContext', () => {
    expect(getAdapter('claude')!.emit(ev('claude', 'restore'), { kind: 'inject', text: 'ctx' }).stdout).toBe('ctx');
    expect(getAdapter('codex')!.emit(ev('codex', 'restore'), { kind: 'inject', text: 'ctx' }).stdout).toBe('ctx');
    expect(JSON.parse(getAdapter('gemini')!.emit(ev('gemini', 'restore'), { kind: 'inject', text: 'ctx' }).stdout))
      .toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' } });
    expect(JSON.parse(getAdapter('copilot')!.emit(ev('copilot', 'restore'), { kind: 'inject', text: 'ctx' }).stdout))
      .toEqual({ additionalContext: 'ctx' });
  });

  it('stop: block decision per host; Codex no-op is JSON (Stop requires JSON stdout)', () => {
    const block = { kind: 'block-stop' as const, reason: 'write handoff', systemMessage: 'note' };
    expect(JSON.parse(getAdapter('claude')!.emit(ev('claude', 'stop'), block).stdout)).toEqual({ decision: 'block', reason: 'write handoff', systemMessage: 'note' });
    expect(JSON.parse(getAdapter('gemini')!.emit(ev('gemini', 'stop'), block).stdout)).toMatchObject({ decision: 'deny', reason: 'write handoff' });
    expect(JSON.parse(getAdapter('copilot')!.emit(ev('copilot', 'stop'), block).stdout)).toEqual({ decision: 'block', reason: 'write handoff' });
    expect(getAdapter('claude')!.emit(ev('claude', 'stop'), { kind: 'noop' }).stdout).toBe('{"decision":"approve"}');
    expect(getAdapter('codex')!.emit(ev('codex', 'stop'), { kind: 'noop' }).stdout).toBe('{}');
  });

  it('context-check inject degrades to a notice where prompt injection is not supported', () => {
    const inject = { kind: 'inject' as const, text: 'handoff please', systemMessage: 'at 80%' };
    expect(JSON.parse(getAdapter('codex')!.emit(ev('codex', 'context-check'), inject).stdout).hookSpecificOutput)
      .toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: 'handoff please' });
    expect(JSON.parse(getAdapter('gemini')!.emit(ev('gemini', 'context-check'), inject).stdout)).toEqual({ systemMessage: 'at 80%' });
  });
});

describe('usage readers per host', () => {
  it('claude and codex fixtures measure through the shared transcript reader', () => {
    const claude = getAdapter('claude')!;
    const c = claude.readUsage({ host: 'claude', role: 'stop', sessionId: 'fixture-claude-0001', transcriptPath: join(fixtures, 'claude', 'transcript.jsonl') }, {});
    expect(c).toMatchObject({ status: 'measured', model: 'claude-opus-4-5', usedTokens: 160_500, contextLimitTokens: 200_000 });
    const codex = getAdapter('codex')!;
    const x = codex.readUsage({ host: 'codex', role: 'stop', transcriptPath: join(fixtures, 'codex', 'rollout.jsonl') }, {});
    expect(x).toMatchObject({ status: 'measured', model: 'gpt-fixture', usedTokens: 382_000, contextLimitTokens: 475_000 });
  });

  it('gemini: tokens.input + tokens.output; window unknown without override or catalog', () => {
    const path = join(fixtures, 'gemini', 'session.jsonl');
    expect(readGeminiContextUsage(path)).toMatchObject({ status: 'unknown_context_limit', model: 'gemini-fixture-pro', usedTokens: 801_200 });
    expect(readGeminiContextUsage(path, 1_000_000)).toMatchObject({ status: 'measured', usedFraction: 0.8012 });
  });

  it('gemini: accepts Gemini API usageMetadata and the catalog window', () => {
    const dir = temp();
    const transcript = join(dir, 's.jsonl');
    writeFileSync(transcript, JSON.stringify({ model: 'gemini-fixture-flash', usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, cachedContentTokenCount: 400 } }) + '\n');
    const catalog = join(dir, 'catalog.json');
    writeFileSync(catalog, JSON.stringify({ google: { models: { 'gemini-fixture-flash': { limit: { context: 1200, output: 100 } } } } }));
    process.env.BOOKMARK_MODEL_CATALOG = catalog;
    try {
      expect(readGeminiContextUsage(transcript)).toMatchObject({ status: 'measured', usedTokens: 600, contextLimitTokens: 1200 });
    } finally {
      process.env.BOOKMARK_MODEL_CATALOG = noCatalog;
    }
  });

  it('copilot: turn-count estimate labelled estimated', () => {
    const path = join(fixtures, 'copilot', 'events.jsonl');
    expect(estimateContextUsageFromTurns(path)).toMatchObject({ status: 'unknown_context_limit', usedTokens: 12_000, source: 'turn_estimate', estimated: true });
    expect(estimateContextUsageFromTurns(path, { override: 16_000, tokensPerTurn: 4000 }))
      .toMatchObject({ status: 'measured', usedFraction: 0.75, estimated: true });
  });
});

describe('resolveContextWindow order (research doc section 10)', () => {
  it('override > reported > catalog > built-in table > null', () => {
    const dir = temp();
    const catalog = join(dir, 'c.json');
    writeFileSync(catalog, JSON.stringify({ anthropic: { models: { 'claude-opus-4-5': { limit: { context: 333 } } } } }));
    expect(resolveContextWindow('claude-opus-4-5', { override: 1, reported: 2, catalogPath: catalog })).toBe(1);
    expect(resolveContextWindow('claude-opus-4-5', { reported: 2, catalogPath: catalog })).toBe(2);
    expect(resolveContextWindow('claude-opus-4-5', { catalogPath: catalog })).toBe(333);
    expect(resolveContextWindow('claude-opus-4-5', { catalogPath: noCatalog })).toBe(200_000);
    expect(resolveContextWindow('unknown-model', { catalogPath: noCatalog })).toBeNull();
  });
});

describe('install merge writer', () => {
  const env = (bin: string) => ({ BOOKMARK_COMPAT_BIN: bin });

  it('merges into an existing config without dropping other hooks, backs up, and is idempotent', () => {
    const home = temp();
    const manifest = loadManifest('codex')!;
    const path = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(path), { recursive: true });
    const other = { hooks: [{ type: 'command', command: 'other-tool on-stop' }] };
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [other], PreToolUse: [other] }, extra: true }));
    const compat = fakeCompat(home, 'codex', ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'Stop']);

    const first = installHost(manifest, { home, env: env(compat), now: new Date('2026-01-01T00:00:00Z') });
    expect(first.changed).toBe(true);
    expect(first.compat.status).toBe('ok');
    expect(first.backupPath && existsSync(first.backupPath)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.extra).toBe(true);
    expect(written.hooks.PreToolUse).toEqual([other]);
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0]).toEqual(other);
    expect(written.hooks.Stop[1].hooks[0].command).toBe(hookCommand(manifest, 'stop'));

    const second = installHost(manifest, { home, env: env(compat) });
    expect(second.changed).toBe(false);
    expect(readdirSync(dirname(path)).filter(f => f.includes('bookmark-backup'))).toHaveLength(1);
  });

  it('dry-run writes nothing', () => {
    const home = temp();
    const result = installHost(loadManifest('gemini')!, { home, dryRun: true, env: env(join(home, 'absent-bin')) });
    expect(result.changed).toBe(true);
    expect(existsSync(result.path)).toBe(false);
  });

  it('replaces an old Bookmark entry in place instead of appending a duplicate', () => {
    const manifest = loadManifest('claude')!;
    const old = { matcher: '', hooks: [{ type: 'command', command: 'npx @tyroneross/bookmark stop' }] };
    const { merged } = mergeHookConfig({ hooks: { Stop: [old] } }, manifest, planEntries(manifest));
    expect((merged.hooks!.Stop as unknown[])).toHaveLength(1);
  });

  it('copilot gets a version-1 flat file', () => {
    const manifest = loadManifest('copilot')!;
    const { merged } = mergeHookConfig({}, manifest, planEntries(manifest));
    expect(merged.version).toBe(1);
    expect((merged.hooks!.agentStop as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'command', timeoutSec: 10 });
  });

  it('compat: absent binary is unavailable (warn, continue); unlisted event is invalid and refuses the write', () => {
    const home = temp();
    const manifest = loadManifest('gemini')!;
    expect(validateEventsWithCompat(manifest, ['SessionStart'], env(join(home, 'absent'))).status).toBe('unavailable');
    const compat = fakeCompat(home, 'gemini', ['SessionStart']);
    const result = installHost(manifest, { home, env: env(compat) });
    expect(result.compat.status).toBe('invalid');
    expect(result.compat.unknownEvents).toEqual(['BeforeAgent', 'PreCompress', 'AfterAgent']);
    expect(existsSync(result.path)).toBe(false);
  });

  it('createAdapter works from a manifest object alone', () => {
    expect(createAdapter(loadManifest('codex')!).id).toBe('codex');
  });
});
