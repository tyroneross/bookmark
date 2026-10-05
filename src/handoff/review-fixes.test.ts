import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreContext } from '../restore/index.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { getLineagePath, getSessionHandoffPath, getSessionStopMarkerPath } from './paths.js';
import { INDEX_MARKER, listLineage, readLineage, sealHandoff, verifyLine } from './lineage.js';
import { decideStop, sealIfChanged } from './stop.js';
import { isEasyTerminalDriving } from './toggle.js';

const ENV_KEYS = [
  'HOME', 'EASY_TERMINAL_PANE_ID', 'ET_STATE_DIR', 'ET_APP_STATE_DIR',
  'BOOKMARK_HANDOFF', 'BOOKMARK_STORAGE_PATH', 'CLAUDE_SESSION_ID', 'CLAUDE_PID',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const temporaryDirectories: string[] = [];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = tempDir('bookmark-home-');
});
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function tempRepo(): { cwd: string; storagePath: string } {
  const cwd = tempDir('bookmark-repo-');
  const storagePath = join(cwd, '.bookmark');
  mkdirSync(storagePath, { recursive: true });
  return { cwd, storagePath };
}

function handoffBody(task: string): string {
  return `<!-- BOOKMARK_IDENTITY
scope: repo
project: example
repo_path: /tmp/example
branch: main
head: abc1234
written: 2026-10-05
-->

## Current task
${task}

## Status
Validated with the unit suite.

## Remaining work
None.

## Decisions
Per-session handoffs.

## Risks and open questions
None known.

## Sources of truth
/tmp/example/src/handoff/lineage.ts

## Next steps
Run \`npx vitest run\` in /tmp/example.
`;
}

function writeHandoff(storagePath: string, sessionId: string, task: string): string {
  const path = getSessionHandoffPath(storagePath, sessionId);
  writeFileAtomic(path, handoffBody(task));
  return path;
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ageFile(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

const HOURS = 60 * 60 * 1000;

describe('R1 nested claude -p in the same pane', () => {
  it('keeps separate pointers, and the parent resumes its own handoff after /clear', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'parent-s1', 'Parent task.');
    sealHandoff({ storagePath, cwd, sessionId: 'parent-s1', paneId: 'P', pid: '100', head: null });
    // The nested child inherits EASY_TERMINAL_PANE_ID but has its own CLAUDE_PID.
    writeHandoff(storagePath, 'child-c1', 'Child task.');
    sealHandoff({ storagePath, cwd, sessionId: 'child-c1', paneId: 'P', pid: '200', head: null });

    expect(readLineage(storagePath, 'pane:P:pid:100')?.session_id).toBe('parent-s1');
    expect(readLineage(storagePath, 'pane:P:pid:200')?.session_id).toBe('child-c1');

    const parent = restoreContext({ cwd, source: 'clear', sessionId: 'parent-s2', paneId: 'P', pid: '100' }).systemMessage!;
    expect(parent).toContain('Parent task.');
    expect(parent).not.toContain('Child task.');
  });

  it('a child stop hook never touches the parent pointer', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'parent', 'Parent task.');
    const parentRecord = sealHandoff({ storagePath, cwd, sessionId: 'parent', paneId: 'P', pid: '100', head: null })!;
    writeHandoff(storagePath, 'child', 'Child task.');
    decideStop({ storagePath, cwd, sessionId: 'child', paneId: 'P', pid: '200', head: null, enabled: true });
    expect(readLineage(storagePath, 'pane:P:pid:100')).toEqual(parentRecord);
  });
});

describe('R2 compact and staleness', () => {
  it('on compact injects only a handoff sealed by the current session', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'earlier', 'Earlier session task.');
    sealHandoff({ storagePath, cwd, sessionId: 'earlier', pid: '5', head: null });

    const other = restoreContext({ cwd, source: 'compact', sessionId: 'current', pid: '5' }).systemMessage!;
    expect(other).not.toContain('Earlier session task.');
    expect(other).toContain('no handoff is linked');

    writeHandoff(storagePath, 'current', 'Current session task.');
    sealHandoff({ storagePath, cwd, sessionId: 'current', pid: '5', head: null });
    const own = restoreContext({ cwd, source: 'compact', sessionId: 'current', pid: '5' }).systemMessage!;
    expect(own).toContain('Current session task.');
  });

  it('warns at 24h and blocks at 72h, measured from sealed_at', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 's', 'Old task.');
    sealHandoff({ storagePath, cwd, sessionId: 's', pid: '5', head: null, now: new Date(Date.now() - 30 * HOURS) });
    const soft = restoreContext({ cwd, source: 'clear', sessionId: 'n1', pid: '5' }).systemMessage!;
    expect(soft).toContain('sealed 30h ago and may be outdated');
    expect(soft).toContain('Old task.');

    sealHandoff({ storagePath, cwd, sessionId: 's', pid: '5', head: null, now: new Date(Date.now() - 80 * HOURS) });
    const hard = restoreContext({ cwd, source: 'clear', sessionId: 'n2', pid: '5' }).systemMessage!;
    expect(hard).toContain('auto-restore BLOCKED');
    expect(hard).toContain('80h stale');
    expect(hard).not.toContain('Old task.');
  });
});

describe('R3 C7 stand-down and C8 reset marker', () => {
  function etState(toggle?: string): string {
    const dir = tempDir('et-state-');
    if (toggle !== undefined) {
      mkdirSync(join(dir, 'settings'), { recursive: true });
      writeFileSync(join(dir, 'settings', 'context-handoff.json'), toggle);
    }
    return dir;
  }

  function writeTap(stateDir: string, pane: string, ageMs = 0): void {
    const path = join(stateDir, 'context-tap', `${pane}.json`);
    mkdirSync(join(stateDir, 'context-tap'), { recursive: true });
    writeFileSync(path, '{}');
    if (ageMs) ageFile(path, ageMs);
  }

  it('detects Easy Terminal driving the pane only with a fresh tap file and the toggle on', () => {
    const on = etState();
    writeTap(on, 'P');
    expect(isEasyTerminalDriving({ ET_STATE_DIR: on, EASY_TERMINAL_PANE_ID: 'P' })).toBe(true);
    expect(isEasyTerminalDriving({ ET_APP_STATE_DIR: on, EASY_TERMINAL_PANE_ID: 'P' })).toBe(true);
    expect(isEasyTerminalDriving({ ET_STATE_DIR: on, EASY_TERMINAL_PANE_ID: 'Q' })).toBe(false);
    expect(isEasyTerminalDriving({ ET_STATE_DIR: on })).toBe(false);

    const stale = etState();
    writeTap(stale, 'P', 11 * 60_000);
    expect(isEasyTerminalDriving({ ET_STATE_DIR: stale, EASY_TERMINAL_PANE_ID: 'P' })).toBe(false);

    const off = etState('{"enabled": false}');
    writeTap(off, 'P');
    expect(isEasyTerminalDriving({ ET_STATE_DIR: off, EASY_TERMINAL_PANE_ID: 'P' })).toBe(false);

    const unreadable = etState('{broken');
    writeTap(unreadable, 'P');
    expect(isEasyTerminalDriving({ ET_STATE_DIR: unreadable, EASY_TERMINAL_PANE_ID: 'P' })).toBe(true);
  });

  it('Stop does not block while Easy Terminal owns the pane', () => {
    const { cwd, storagePath } = tempRepo();
    expect(decideStop({ storagePath, cwd, sessionId: 's', pid: '1', head: null, enabled: true, easyTerminalDriving: true }))
      .toMatchObject({ decision: 'approve', why: 'easy_terminal_owns_pane' });
    expect(existsSync(getSessionStopMarkerPath(storagePath, 's'))).toBe(false);
  });

  function writeMarker(stateDir: string, pane: string, body: unknown, ageMs = 0): string {
    const dir = join(stateDir, 'context-handoff', 'resets');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${pane}.json`);
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    if (ageMs) ageFile(path, ageMs);
    return path;
  }

  it('injects the marker file instead of lineage on clear, then consumes the marker', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'lineage-sess', 'Lineage task.');
    sealHandoff({ storagePath, cwd, sessionId: 'lineage-sess', paneId: 'P', pid: '1', head: null });
    const snapshot = join(tempDir('et-snap-'), 'handoff.abcd1234.md');
    writeFileSync(snapshot, handoffBody('Snapshot task.'));
    const stateDir = etState();
    const markerPath = writeMarker(stateDir, 'P', {
      path: snapshot, sha256: sha(snapshot), written_at: '2026-10-05T16:00:00Z', provider: 'claude',
    });

    const env = { ET_STATE_DIR: stateDir, EASY_TERMINAL_PANE_ID: 'P' };
    const message = restoreContext({ cwd, source: 'clear', sessionId: 'new', paneId: 'P', pid: '1', env }).systemMessage!;
    expect(message).toContain(`Path: ${snapshot}`);
    expect(message).toContain(`sha256: ${sha(snapshot)}`);
    expect(message).toContain(verifyLine(snapshot, sha(snapshot)));
    expect(message).toContain('Snapshot task.');
    expect(message).not.toContain('Lineage task.');
    expect(message).not.toContain('WARNING');
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(`${markerPath}.consumed`)).toBe(true);

    // Consumed: the next start uses lineage again.
    const next = restoreContext({ cwd, source: 'clear', sessionId: 'new2', paneId: 'P', pid: '1', env }).systemMessage!;
    expect(next).toContain('Lineage task.');
  });

  it('flags a sha mismatch and a missing file', () => {
    const { cwd } = tempRepo();
    const snapshot = join(tempDir('et-snap-'), 'h.md');
    writeFileSync(snapshot, handoffBody('Changed.'));
    const stateDir = etState();
    const env = { ET_STATE_DIR: stateDir, EASY_TERMINAL_PANE_ID: 'P' };

    writeMarker(stateDir, 'P', { path: snapshot, sha256: 'a'.repeat(64), written_at: 'x' });
    const mismatch = restoreContext({ cwd, source: 'startup', sessionId: 's1', env }).systemMessage!;
    expect(mismatch).toContain(`WARNING: the file's current sha256 is ${sha(snapshot)}`);
    expect(mismatch).toContain(verifyLine(snapshot, 'a'.repeat(64)));

    writeMarker(stateDir, 'P', { path: join(stateDir, 'gone.md'), sha256: 'b'.repeat(64) });
    const missing = restoreContext({ cwd, source: 'startup', sessionId: 's2', env }).systemMessage!;
    expect(missing).toContain('WARNING: the handoff file is missing.');
  });

  it('ignores old or malformed markers and compact starts', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'lineage-sess', 'Lineage task.');
    sealHandoff({ storagePath, cwd, sessionId: 'lineage-sess', paneId: 'P', pid: '1', head: null });
    const snapshot = join(tempDir('et-snap-'), 'h.md');
    writeFileSync(snapshot, handoffBody('Snapshot task.'));
    const stateDir = etState();
    const env = { ET_STATE_DIR: stateDir, EASY_TERMINAL_PANE_ID: 'P' };

    const old = writeMarker(stateDir, 'P', { path: snapshot, sha256: sha(snapshot) }, 11 * 60_000);
    expect(restoreContext({ cwd, source: 'clear', sessionId: 'a', paneId: 'P', pid: '1', env }).systemMessage)
      .toContain('Lineage task.');
    expect(existsSync(old)).toBe(true);

    writeMarker(stateDir, 'P', '{not json');
    expect(restoreContext({ cwd, source: 'clear', sessionId: 'b', paneId: 'P', pid: '1', env }).systemMessage)
      .toContain('Lineage task.');

    writeMarker(stateDir, 'P', { path: snapshot });
    expect(restoreContext({ cwd, source: 'clear', sessionId: 'c', paneId: 'P', pid: '1', env }).systemMessage)
      .toContain('Lineage task.');

    writeMarker(stateDir, 'P', { path: snapshot, sha256: sha(snapshot) });
    const compact = restoreContext({ cwd, source: 'compact', sessionId: 'lineage-sess', paneId: 'P', pid: '1', env }).systemMessage!;
    expect(compact).not.toContain('Snapshot task.');
  });
});

describe('R4 seal on change without an age requirement', () => {
  it('seals an hour-old handoff, skips unchanged bytes, reseals edits, ignores invalid files', () => {
    const { cwd, storagePath } = tempRepo();
    const context = { storagePath, cwd, sessionId: 's', pid: '3', head: null };
    const path = writeHandoff(storagePath, 's', 'First.');
    ageFile(path, HOURS);

    const first = sealIfChanged({ ...context, now: Date.now() - 60_000 })!;
    expect(first.sha256).toBe(sha(path));
    expect(sealIfChanged(context)!.sealed_at).toBe(first.sealed_at);

    writeHandoff(storagePath, 's', 'Second.');
    const second = sealIfChanged(context)!;
    expect(second.sha256).toBe(sha(path));
    expect(second.sha256).not.toBe(first.sha256);

    writeFileAtomic(path, 'too short');
    expect(sealIfChanged(context)?.sha256).toBe(second.sha256);
  });
});

describe('R5 legacy bookmark.context.md migration', () => {
  it('moves the legacy file before the first index write and seals it under `legacy`', () => {
    const { cwd, storagePath } = tempRepo();
    const contextPath = join(storagePath, 'bookmark.context.md');
    const legacyBytes = handoffBody('Legacy work in progress.');
    writeFileSync(contextPath, legacyBytes);

    writeHandoff(storagePath, 's', 'New task.');
    sealHandoff({ storagePath, cwd, sessionId: 's', pid: '1', head: null });

    const moved = join(storagePath, 'sessions', 'legacy', 'handoff.md');
    expect(readFileSync(moved, 'utf-8')).toBe(legacyBytes);
    const legacy = readLineage(storagePath, 'legacy')!;
    expect(legacy).toMatchObject({ key: 'legacy', session_id: 'legacy', handoff_path: moved, sha256: sha(moved) });
    expect(getLineagePath(storagePath, 'legacy')).toBe(join(storagePath, 'lineage', 'legacy.json'));

    const index = readFileSync(contextPath, 'utf-8');
    expect(index.startsWith(INDEX_MARKER)).toBe(true);
    expect(index).toContain(moved);

    // Listed, never auto-restored.
    const message = restoreContext({ cwd, source: 'clear', sessionId: 'x', pid: '999' }).systemMessage!;
    expect(message).toContain('no handoff is linked');
    expect(message).toContain(moved);
    expect(message).not.toContain('Legacy work in progress.');

    // A second seal leaves the moved file alone.
    sealHandoff({ storagePath, cwd, sessionId: 's', pid: '1', head: null });
    expect(readFileSync(moved, 'utf-8')).toBe(legacyBytes);
    expect(listLineage(storagePath).map(record => record.key).sort()).toEqual(['legacy', 'pid:1']);
  });
});

describe('20 sessions: 10 panes, each with a parent and a nested claude -p child', () => {
  it('each process resumes its own handoff; the index lists all 20', () => {
    const { cwd, storagePath } = tempRepo();
    const sessions = Array.from({ length: 20 }, (_, i) => ({
      sid: `s${i}-${Math.random().toString(36).slice(2, 8)}`,
      pane: `pane-${Math.floor(i / 2)}`,
      pid: String(5000 + i),
      role: i % 2 === 0 ? 'parent' : 'child',
    }));
    const order = sessions.map((_, i) => (i * 11 + 3) % 20);

    for (const i of order) writeHandoff(storagePath, sessions[i].sid, `Work ${i} ${sessions[i].role} ${sessions[i].sid}`);
    for (const i of order) {
      const s = sessions[i];
      if (i % 3 === 0) writeHandoff(storagePath, s.sid, `Revised ${i} ${s.role} ${s.sid}`);
      decideStop({ storagePath, cwd, sessionId: s.sid, paneId: s.pane, pid: s.pid, head: null, enabled: true });
    }

    for (const [i, s] of sessions.entries()) {
      const message = restoreContext({ cwd, source: 'clear', sessionId: `next-${i}`, paneId: s.pane, pid: s.pid }).systemMessage!;
      expect(message).toContain(`Session: ${s.sid}`);
      expect(message).toContain(`sha256: ${sha(getSessionHandoffPath(storagePath, s.sid))}`);
      expect(message).toContain(`${i % 3 === 0 ? 'Revised' : 'Work'} ${i} ${s.role} ${s.sid}`);
      expect(message).not.toContain('WARNING');
      for (const [k, other] of sessions.entries()) {
        if (k !== i) expect(message).not.toContain(other.sid);
      }
    }

    const index = readFileSync(join(storagePath, 'bookmark.context.md'), 'utf-8');
    for (const s of sessions) expect(index).toContain(`pane:${s.pane}:pid:${s.pid}`);
    expect(listLineage(storagePath)).toHaveLength(20);
  });
});
