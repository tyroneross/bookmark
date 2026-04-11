import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIdentity, validateRepoIdentity, followPointer } from './identity.js';

describe('parseIdentity', () => {
  it('returns null identity when no block is present', () => {
    const { identity, bodyWithoutIdentity } = parseIdentity(
      '# Session\n\nJust a body without an identity block.'
    );
    expect(identity).toBeNull();
    expect(bodyWithoutIdentity).toContain('Just a body');
  });

  it('parses a repo-scoped identity block', () => {
    const content = `# Session Context

<!-- BOOKMARK_IDENTITY
scope: repo
project: travel-planner
repo_path: /Users/me/Desktop/git-folder/Travel Planner
branch: feature/summer-camps
head: 4988383
written: 2026-04-11
-->

## Current Task
Doing stuff.`;

    const { identity, bodyWithoutIdentity } = parseIdentity(content);
    expect(identity).not.toBeNull();
    expect(identity!.scope).toBe('repo');
    expect(identity!.project).toBe('travel-planner');
    expect(identity!.repo_path).toBe('/Users/me/Desktop/git-folder/Travel Planner');
    expect(identity!.branch).toBe('feature/summer-camps');
    expect(identity!.head).toBe('4988383');
    // Body should no longer contain the HTML comment block
    expect(bodyWithoutIdentity).not.toContain('BOOKMARK_IDENTITY');
    expect(bodyWithoutIdentity).toContain('Current Task');
  });

  it('parses a home-scoped pointer', () => {
    const content = `# Pointer

<!-- BOOKMARK_IDENTITY
scope: home
project: POINTER_ONLY
points_to_project: travel-planner
points_to_canonical: /Users/me/Desktop/git-folder/Travel Planner/.bookmark/bookmark.context.md
written: 2026-04-11
-->

Pointer body.`;
    const { identity } = parseIdentity(content);
    expect(identity!.scope).toBe('home');
    expect(identity!.points_to_project).toBe('travel-planner');
    expect(identity!.points_to_canonical).toContain('Travel Planner');
  });

  it('preserves unknown keys in raw for forward compatibility', () => {
    const content = `<!-- BOOKMARK_IDENTITY
scope: repo
future_key: future_value
-->
body`;
    const { identity } = parseIdentity(content);
    expect(identity!.raw.future_key).toBe('future_value');
  });

  it('defaults scope to repo when the field is absent', () => {
    const content = `<!-- BOOKMARK_IDENTITY
project: something
-->
body`;
    const { identity } = parseIdentity(content);
    expect(identity!.scope).toBe('repo');
  });
});

describe('validateRepoIdentity', () => {
  it('returns null when repo_path matches cwd exactly', () => {
    const identity = {
      scope: 'repo' as const,
      repo_path: '/tmp/myrepo',
      raw: {},
    };
    expect(validateRepoIdentity(identity, '/tmp/myrepo')).toBeNull();
  });

  it('returns null when cwd is a subdirectory of repo_path', () => {
    const identity = {
      scope: 'repo' as const,
      repo_path: '/tmp/myrepo',
      raw: {},
    };
    expect(validateRepoIdentity(identity, '/tmp/myrepo/src/nested')).toBeNull();
  });

  it('returns a warning when repo_path and cwd disagree', () => {
    const identity = {
      scope: 'repo' as const,
      repo_path: '/tmp/projectA',
      raw: {},
    };
    const warning = validateRepoIdentity(identity, '/tmp/projectB');
    expect(warning).not.toBeNull();
    expect(warning).toContain('identity mismatch');
    expect(warning).toContain('/tmp/projectA');
    expect(warning).toContain('/tmp/projectB');
  });

  it('returns null for home-scoped identities (not their job to validate)', () => {
    const identity = {
      scope: 'home' as const,
      points_to_canonical: '/tmp/anywhere',
      raw: {},
    };
    expect(validateRepoIdentity(identity, '/tmp/wherever')).toBeNull();
  });

  it('returns null when repo_path is missing (can not validate)', () => {
    const identity = { scope: 'repo' as const, raw: {} };
    expect(validateRepoIdentity(identity, '/tmp/anywhere')).toBeNull();
  });
});

describe('followPointer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bookmark-identity-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('follows a pointer to an existing target', () => {
    const targetPath = join(tmpDir, 'target.md');
    writeFileSync(
      targetPath,
      `<!-- BOOKMARK_IDENTITY
scope: repo
project: real-project
-->
# Real content`
    );

    const pointer = {
      scope: 'home' as const,
      points_to_canonical: targetPath,
      raw: {},
    };

    const target = followPointer(pointer);
    expect(target).not.toBeNull();
    expect(target!.canonical_path).toBe(targetPath);
    expect(target!.content).toContain('Real content');
    expect(target!.identity?.project).toBe('real-project');
    expect(target!.staleness_hours).toBeGreaterThanOrEqual(0);
  });

  it('returns null when target file does not exist', () => {
    const pointer = {
      scope: 'home' as const,
      points_to_canonical: join(tmpDir, 'missing.md'),
      raw: {},
    };
    expect(followPointer(pointer)).toBeNull();
  });

  it('returns null for repo-scoped identities (nothing to follow)', () => {
    const identity = { scope: 'repo' as const, raw: {} };
    expect(followPointer(identity)).toBeNull();
  });

  it('returns null when points_to_canonical is missing', () => {
    const identity = { scope: 'home' as const, raw: {} };
    expect(followPointer(identity)).toBeNull();
  });
});
