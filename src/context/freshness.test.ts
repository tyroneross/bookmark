import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isContextMdFresh } from './freshness.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validHandoff(): string {
  return `<!-- BOOKMARK_IDENTITY
scope: repo
project: example
repo_path: /tmp/example
branch: main
head: abc1234
written: 2026-08-29
-->

## Current task
Implement threshold capture.

## Status
Validated locally with the unit suite.

## Remaining work
Commit the implementation.

## Decisions
Use transcript-reported usage.

## Risks and open questions
Transcript schemas can change.

## Sources of truth
/tmp/example/src/threshold/token-usage.ts

## Next steps
Run tests in /tmp/example/package.json.
`;
}

describe('isContextMdFresh', () => {
  it('accepts a recent handoff with identity and all required sections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bookmark-freshness-'));
    temporaryDirectories.push(directory);
    const contextPath = join(directory, 'bookmark.context.md');
    writeFileSync(contextPath, validHandoff());

    expect(isContextMdFresh(contextPath, join(directory, '.stop-requested'))).toBe(true);
  });

  it('rejects a handoff older than two minutes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bookmark-freshness-'));
    temporaryDirectories.push(directory);
    const contextPath = join(directory, 'bookmark.context.md');
    writeFileSync(contextPath, validHandoff());
    const old = new Date(Date.now() - 3 * 60 * 1000);
    utimesSync(contextPath, old, old);

    expect(isContextMdFresh(contextPath, join(directory, '.stop-requested'))).toBe(false);
  });

  it('rejects recent content that omits a required section', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bookmark-freshness-'));
    temporaryDirectories.push(directory);
    const contextPath = join(directory, 'bookmark.context.md');
    writeFileSync(contextPath, validHandoff().replace('## Remaining work', '## Work'));

    expect(isContextMdFresh(contextPath, join(directory, '.stop-requested'))).toBe(false);
  });
});
