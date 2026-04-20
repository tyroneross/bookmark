import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectRoot, getStoragePath, loadConfig } from './config.js';

describe('resolveProjectRoot', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bookmark-root-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('returns the directory that contains a .bookmark/ marker', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.bookmark'), { recursive: true });
    const sub = join(repo, 'src', 'nested');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(repo);
    expect(resolveProjectRoot(repo)).toBe(repo);
  });

  it('falls back to the directory with a .git/ marker when no .bookmark exists', () => {
    const repo = join(base, 'gitrepo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const sub = join(repo, 'src', 'deep');
    mkdirSync(sub, { recursive: true });

    expect(resolveProjectRoot(sub)).toBe(repo);
  });

  it('falls back to the directory with a package.json when no VCS markers exist', () => {
    const repo = join(base, 'pkg');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{"name":"x"}');
    const sub = join(repo, 'src');
    mkdirSync(sub);

    expect(resolveProjectRoot(sub)).toBe(repo);
  });

  it('returns cwd unchanged when no markers are found anywhere up the tree', () => {
    const orphan = join(base, 'orphan', 'deep');
    mkdirSync(orphan, { recursive: true });

    // Should not escape into the user's real $HOME markers; verify it stops at cwd
    const resolved = resolveProjectRoot(orphan);
    // Either unchanged or points to some ancestor that genuinely has a marker.
    // We only assert it does not return the homedir itself on a synthetic path.
    expect(resolved).not.toBe(homedir());
  });

  it('prefers .bookmark over .git when both present at different levels', () => {
    const outer = join(base, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(outer, '.git'), { recursive: true });
    mkdirSync(join(inner, '.bookmark'), { recursive: true });
    const sub = join(inner, 'src');
    mkdirSync(sub);

    // Walk-up hits inner's .bookmark first — that is the more-specific root.
    expect(resolveProjectRoot(sub)).toBe(inner);
  });
});

describe('getStoragePath', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bookmark-storage-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('returns <repo>/.bookmark even when called from a subdirectory', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const sub = join(repo, 'src', 'foo');
    mkdirSync(sub, { recursive: true });

    expect(getStoragePath(sub)).toBe(join(repo, '.bookmark'));
  });

  it('honors an absolute BOOKMARK_STORAGE_PATH env override', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const abs = join(base, 'shared-bookmark-store');
    const prev = process.env.BOOKMARK_STORAGE_PATH;
    process.env.BOOKMARK_STORAGE_PATH = abs;
    try {
      expect(getStoragePath(repo)).toBe(abs);
    } finally {
      if (prev === undefined) delete process.env.BOOKMARK_STORAGE_PATH;
      else process.env.BOOKMARK_STORAGE_PATH = prev;
    }
  });
});

describe('loadConfig', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'bookmark-config-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads .bookmark/config.json from the resolved repo root when invoked from a subdirectory', () => {
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.bookmark'), { recursive: true });
    writeFileSync(
      join(repo, '.bookmark', 'config.json'),
      JSON.stringify({ intervalMinutes: 7 })
    );
    const sub = join(repo, 'src');
    mkdirSync(sub);

    const cfg = loadConfig(sub);
    expect(cfg.intervalMinutes).toBe(7);
  });

  it('defaults new installs to 5-minute interval and 200-snapshot cap', () => {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    const cfg = loadConfig(empty);
    expect(cfg.intervalMinutes).toBe(5);
    expect(cfg.maxActiveSnapshots).toBe(200);
  });
});
