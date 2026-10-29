import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from './manifest.js';
import { DEFAULT_BIN, hookCommand, installHost, mergeHookConfig, planEntries, readJsonConfig, removeBookmarkHooks, writeJsonConfig } from './install.js';
import { configureGlobalHooks } from '../setup/configure-hooks.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bookmark-install-'));
  temps.push(dir);
  return dir;
}

describe('audit round 1: writer safety', () => {
  const codex = () => loadManifest('codex')!;
  const claude = () => loadManifest('claude')!;

  it('H3: keeps sibling handlers in a mixed group and replaces only the Bookmark handler', () => {
    const sibling = { type: 'command', command: 'other-tool on-stop' };
    const group = { matcher: '', hooks: [sibling, { type: 'command', command: 'npx @tyroneross/bookmark stop' }] };
    const { merged } = mergeHookConfig({ hooks: { Stop: [group] } }, claude(), planEntries(claude()));
    const stop = merged.hooks!.Stop as Array<{ hooks: Array<Record<string, unknown>> }>;
    expect(stop).toHaveLength(2);
    expect(stop[0].hooks[0].command).toBe(hookCommand(claude(), 'stop'));
    expect(stop[1]).toEqual({ matcher: '', hooks: [sibling] });
  });

  it('H3: --bin node does not touch an unrelated node hook (or one whose matcher says node)', () => {
    const unrelated = { matcher: 'node', hooks: [{ type: 'command', command: 'node /opt/lint.js' }] };
    const entries = planEntries(codex(), 'node /opt/bookmark/dist/cli/index.js');
    const { merged } = mergeHookConfig({ hooks: { Stop: [unrelated] } }, codex(), entries);
    expect((merged.hooks!.Stop as unknown[])[0]).toEqual(unrelated);
    expect(merged.hooks!.Stop).toHaveLength(2);
  });

  it('H3: removes duplicate Bookmark handlers, leaving one', () => {
    const dup = (cmd: string) => ({ hooks: [{ type: 'command', command: cmd }] });
    const existing = { hooks: { Stop: [dup('npx @tyroneross/bookmark stop'), dup('other'), dup('npx @tyroneross/bookmark stop --host codex 2>/dev/null || echo \'{}\'')] } };
    const { merged } = mergeHookConfig(existing, codex(), planEntries(codex()));
    const commands = (merged.hooks!.Stop as Array<{ hooks: Array<{ command: string }> }>).map(g => g.hooks[0].command);
    expect(commands).toEqual([hookCommand(codex(), 'stop'), 'other']);
  });

  it('H3/L7: re-install with a different custom --bin replaces, not appends', () => {
    const first = mergeHookConfig({}, codex(), planEntries(codex(), 'node /a/dist/cli/index.js')).merged;
    const second = mergeHookConfig(first, codex(), planEntries(codex(), 'node /b/dist/cli/index.js')).merged;
    const stop = second.hooks!.Stop as Array<{ hooks: Array<{ command: string }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0].hooks[0].command).toContain('/b/dist');
    expect(mergeHookConfig(second, codex(), planEntries(codex(), 'node /b/dist/cli/index.js')).changed).toBe(false);
  });

  it('H3: remove keeps siblings', () => {
    const group = { matcher: '', hooks: [{ type: 'command', command: 'keep-me' }, { type: 'command', command: hookCommand(claude(), 'stop') }] };
    const { merged } = removeBookmarkHooks({ hooks: { Stop: [group] } }, 'grouped');
    expect(merged.hooks!.Stop).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] }]);
  });

  it('H4: a 0600 config stays 0600 (and its backup too); a new file is 0600', () => {
    const dir = temp();
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o600);
    const backup = writeJsonConfig(path, { a: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    const fresh = join(dir, 'new', 'hooks.json');
    writeJsonConfig(fresh, { b: 1 });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it('H4: writes through a symlink and keeps the link', () => {
    const dir = temp();
    const target = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(target, '{}');
    chmodSync(target, 0o640);
    symlinkSync(target, link);
    writeJsonConfig(link, { c: 1 });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ c: 1 });
    expect(execFileSync('readlink', [link], { encoding: 'utf-8' }).trim()).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it('H2/L7: malformed JSON is refused by install and by setup, and the file is untouched', () => {
    const home = temp();
    const codexPath = join(home, '.codex', 'hooks.json');
    mkdirSync(dirname(codexPath), { recursive: true });
    writeFileSync(codexPath, '{ not json');
    expect(() => installHost(codex(), { home, env: { BOOKMARK_COMPAT_BIN: join(home, 'absent') } })).toThrow(/not valid JSON/);
    expect(readFileSync(codexPath, 'utf-8')).toBe('{ not json');
    expect(() => readJsonConfig(codexPath)).toThrow();

    const claudePath = join(home, '.claude', 'settings.json');
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(claudePath, '{ broken');
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(() => configureGlobalHooks()).toThrow(/not valid JSON/);
    } finally {
      process.env.HOME = previousHome;
    }
    expect(readFileSync(claudePath, 'utf-8')).toBe('{ broken');
    expect(readdirSync(dirname(claudePath))).toEqual(['settings.json']);
  });

  it('H5: the default command is npx -y pinned to this package version', () => {
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version;
    expect(DEFAULT_BIN).toBe(`npx -y @tyroneross/bookmark@${version}`);
  });

  it('M1: --bin with shell metacharacters is rejected', () => {
    for (const bin of ["node x; rm -rf ~", 'node $(id)', "node 'x'", 'a|b', 'a && b']) {
      expect(() => planEntries(codex(), bin)).toThrow(/--bin/);
    }
  });
});

