import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHandoffPrompt } from '../context/handoff-prompt.js';
import { isContextMdFresh } from '../context/freshness.js';
import { restoreContext } from '../restore/index.js';
import { loadSessionState, saveSessionState, saveState, loadState } from '../threshold/state.js';
import { readLatestContextUsage } from '../threshold/token-usage.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import {
  getLineagePath,
  getSessionDir,
  getSessionHandoffPath,
  getSessionStopMarkerPath,
  lineageKey,
  safeSegment,
} from './paths.js';
import {
  INDEX_MARKER,
  buildKickoff,
  findLineageBySession,
  listLineage,
  readLineage,
  sealHandoff,
  verifyHandoff,
  verifyLine,
} from './lineage.js';
import { decideStop } from './stop.js';
import { isHandoffEnabled, readEasyTerminalToggle } from './toggle.js';

const ENV_KEYS = [
  'HOME',
  'EASY_TERMINAL_PANE_ID',
  'ET_STATE_DIR',
  'ET_APP_STATE_DIR',
  'BOOKMARK_HANDOFF',
  'BOOKMARK_STORAGE_PATH',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PID',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const temporaryDirectories: string[] = [];

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  // restore touches the global registry under $HOME; keep it in a temp dir.
  process.env.HOME = tempDir('bookmark-home-');
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

function handoffBody(sessionId: string, pane: string, task = `Task for ${sessionId}`): string {
  return `<!-- BOOKMARK_IDENTITY
scope: repo
project: example
repo_path: /tmp/example
branch: main
head: abc1234
written: 2026-10-05
session_id: ${sessionId}
pane: ${pane}
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

function writeHandoff(storagePath: string, sessionId: string, pane: string, task?: string): string {
  const path = getSessionHandoffPath(storagePath, sessionId);
  writeFileAtomic(path, handoffBody(sessionId, pane, task));
  return path;
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function ageFile(path: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(path, when, when);
}

describe('C6 atomic writes', () => {
  it('replaces the file and leaves no temp files behind', () => {
    const dir = tempDir('bookmark-atomic-');
    const path = join(dir, 'nested', 'file.json');
    writeFileAtomic(path, 'one');
    writeFileAtomic(path, 'two');
    expect(readFileSync(path, 'utf-8')).toBe('two');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['file.json']);
  });
});

describe('A1 per-session directory and state', () => {
  it('keeps threshold dedupe per session and seeds only config from legacy state', () => {
    const { storagePath } = tempRepo();
    const legacy = loadState(storagePath);
    legacy.snapshot_interval_minutes = 15;
    legacy.token_thresholds_triggered = [0.75];
    saveState(storagePath, legacy);
    const legacyBytes = readFileSync(join(storagePath, 'state.json'), 'utf-8');

    const first = loadSessionState(storagePath, 'sess-a');
    expect(first.snapshot_interval_minutes).toBe(15);
    expect(first.token_thresholds_triggered).toBeUndefined();
    saveSessionState(storagePath, 'sess-a', { ...first, token_thresholds_triggered: [0.75] });

    expect(loadSessionState(storagePath, 'sess-a').token_thresholds_triggered).toEqual([0.75]);
    expect(loadSessionState(storagePath, 'sess-b').token_thresholds_triggered).toBeUndefined();
    expect(existsSync(join(storagePath, 'sessions', 'sess-a', 'state.json'))).toBe(true);
    expect(readFileSync(join(storagePath, 'state.json'), 'utf-8')).toBe(legacyBytes);
  });

  it('places handoff and stop marker in the session dir and refuses path traversal', () => {
    const { storagePath } = tempRepo();
    expect(getSessionHandoffPath(storagePath, 'sid1')).toBe(join(storagePath, 'sessions', 'sid1', 'handoff.md'));
    expect(getSessionStopMarkerPath(storagePath, 'sid1')).toBe(join(storagePath, 'sessions', 'sid1', 'stop-requested'));
    expect(getSessionDir(storagePath, '../escape')).toBe(join(storagePath, 'sessions', safeSegment('../escape')));
    expect(safeSegment('../escape')).toMatch(/^h-[0-9a-f]{32}$/);
  });
});

describe('A2 handoff prompt', () => {
  it('names the per-session path and asks for session_id, pane and exact check commands', () => {
    const prompt = buildHandoffPrompt({
      cwd: '/tmp/repo',
      reason: 'Stopping.',
      handoffPath: '/tmp/repo/.bookmark/sessions/s-1/handoff.md',
      sessionId: 's-1',
      paneId: 'pane-9',
    });
    expect(prompt).toContain('Write or replace /tmp/repo/.bookmark/sessions/s-1/handoff.md now.');
    expect(prompt).toContain('session_id: s-1');
    expect(prompt).toContain('pane: pane-9');
    expect(prompt).toContain('exact command');
    expect(prompt).toContain('This file belongs to this session only.');
    expect(prompt).not.toContain('bookmark.context.md');
    expect(prompt.length).toBeLessThan(1_500);
  });
});

describe('A3 seal', () => {
  it('writes the lineage pointer with the C4 hash and regenerates the index', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 'sess-1', 'p1');
    const record = sealHandoff({ storagePath, cwd, sessionId: 'sess-1', paneId: 'p1', pid: '41', head: 'deadbeef' })!;

    expect(record.sha256).toBe(sha(path));
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record).toMatchObject({ key: 'pane:p1:pid:41', session_id: 'sess-1', pane: 'p1', pid: '41', handoff_path: path, head: 'deadbeef' });
    const lineage = JSON.parse(readFileSync(getLineagePath(storagePath, 'pane:p1:pid:41'), 'utf-8'));
    expect(lineage.sha256).toBe(record.sha256);
    expect(getLineagePath(storagePath, 'pane:p1:pid:41')).toBe(join(storagePath, 'lineage', 'pane:p1:pid:41.json'));

    const index = readFileSync(join(storagePath, 'bookmark.context.md'), 'utf-8');
    expect(index.split('\n')[0]).toBe(INDEX_MARKER);
    expect(index).toContain(path);
    expect(index).toContain(record.sha256);
    // The generated index is never accepted as a handoff, even when fresh.
    expect(isContextMdFresh(join(storagePath, 'bookmark.context.md'), join(storagePath, 'none'))).toBe(false);
  });

  it("builds C2' keys: pane+pid, pid, else session", () => {
    expect(lineageKey({ paneId: 'p', pid: '7', sessionId: 's' })).toBe('pane:p:pid:7');
    expect(lineageKey({ pid: '7', sessionId: 's' })).toBe('pid:7');
    expect(lineageKey({ paneId: 'p', sessionId: 's' })).toBe('session:s');
    expect(lineageKey({ sessionId: 's' })).toBe('session:s');
    expect(lineageKey({})).toBeNull();
  });
});

describe('A4 SessionStart restore', () => {
  it('injects the handoff linked to this pane with a C5 header', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 'old-sess', 'pane-1', 'Ship the lineage restore.');
    const record = sealHandoff({ storagePath, cwd, sessionId: 'old-sess', paneId: 'pane-1', pid: '100', head: null })!;

    const result = restoreContext({ cwd, source: 'clear', sessionId: 'new-sess', paneId: 'pane-1', pid: '100' });
    const message = result.systemMessage!;
    expect(message).toContain('Session: old-sess');
    expect(message).toContain('Pane: pane-1');
    expect(message).toContain(`Path: ${path}`);
    expect(message).toContain(`sha256: ${record.sha256}`);
    expect(message).toContain(
      `Verify first: \`shasum -a 256 '${path}'\` must print ${record.sha256}. If it differs or the file is missing, stop and ask the owner; do not act on it.`
    );
    expect(message).toContain('Ship the lineage restore.');
    expect(message).not.toContain('WARNING');
  });

  it('says so when the file changed after sealing, and still injects it', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 'old-sess', 'pane-1');
    const record = sealHandoff({ storagePath, cwd, sessionId: 'old-sess', paneId: 'pane-1', pid: '100', head: null })!;
    appendFileSync(path, '\nedited later\n');

    const message = restoreContext({ cwd, source: 'clear', sessionId: 'n', paneId: 'pane-1', pid: '100' }).systemMessage!;
    expect(message).toContain(`WARNING: the file's current sha256 is ${sha(path)}, not the sealed ${record.sha256}`);
    expect(message).toContain('edited later');
  });

  it('injects the index instead of guessing when nothing is linked', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 'other', 'pane-2');
    sealHandoff({ storagePath, cwd, sessionId: 'other', paneId: 'pane-2', pid: '200', head: null });

    const message = restoreContext({ cwd, source: 'startup', sessionId: 'fresh', paneId: 'pane-3', pid: '300' }).systemMessage!;
    expect(message).toContain('no handoff is linked to this pane/session (pane:pane-3:pid:300); pick one from the list');
    expect(message).toContain(INDEX_MARKER);
    expect(message).toContain(getSessionHandoffPath(storagePath, 'other'));
    expect(message).not.toContain('## Current task');
  });

  it('restores the legacy single file when no session has sealed a handoff', () => {
    const { cwd, storagePath } = tempRepo();
    const legacyPath = join(storagePath, 'bookmark.context.md');
    writeFileSync(legacyPath, handoffBody('legacy', 'none', 'Legacy task continues.'));

    const message = restoreContext({ cwd, source: 'startup', sessionId: 'new' }).systemMessage!;
    expect(message).toContain('Legacy task continues.');
    expect(existsSync(legacyPath)).toBe(true);
  });
});

describe('A5 context-check usage filter', () => {
  it('only counts usage records from the hook session', () => {
    const dir = tempDir('bookmark-transcript-');
    const transcript = join(dir, 't.jsonl');
    const record = (sessionId: string, input: number) => JSON.stringify({
      type: 'assistant',
      sessionId,
      message: { model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: 0 } },
    });
    writeFileSync(transcript, [record('mine', 100_000), record('theirs', 900_000)].join('\n') + '\n');

    expect(readLatestContextUsage(transcript, undefined, '', 'mine')?.usedTokens).toBe(100_000);
    expect(readLatestContextUsage(transcript, undefined, '', 'theirs')?.usedTokens).toBe(900_000);
    expect(readLatestContextUsage(transcript)?.usedTokens).toBe(900_000);
  });
});

describe('A6 stop decision', () => {
  it('blocks at most once per session', () => {
    const { cwd, storagePath } = tempRepo();
    const base = { storagePath, cwd, paneId: 'p', head: 'h1', enabled: true };
    expect(decideStop({ ...base, sessionId: 's1' })).toMatchObject({ decision: 'block', handoffPath: getSessionHandoffPath(storagePath, 's1') });
    expect(existsSync(getSessionStopMarkerPath(storagePath, 's1'))).toBe(true);
    expect(decideStop({ ...base, sessionId: 's1' })).toMatchObject({ decision: 'approve', why: 'already_blocked' });
    // Another session in the same repo still gets its own block.
    expect(decideStop({ ...base, sessionId: 's2', paneId: 'q' })).toMatchObject({ decision: 'block' });
  });

  it('approves and seals a fresh handoff', () => {
    const { cwd, storagePath } = tempRepo();
    writeHandoff(storagePath, 's1', 'p');
    const result = decideStop({ storagePath, cwd, sessionId: 's1', paneId: 'p', pid: '1', head: 'h1', enabled: true });
    expect(result).toMatchObject({ decision: 'approve', why: 'fresh_handoff' });
    expect(readLineage(storagePath, 'pane:p:pid:1')?.session_id).toBe('s1');
  });

  it('approves a sealed handoff under 10 minutes old at the same HEAD only', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 's1', 'p');
    ageFile(path, 5 * 60_000);
    sealHandoff({ storagePath, cwd, sessionId: 's1', paneId: 'p', pid: '1', head: 'h1', now: new Date(Date.now() - 5 * 60_000) });

    const base = { storagePath, cwd, sessionId: 's1', paneId: 'p', pid: '1', enabled: true };
    expect(decideStop({ ...base, head: 'h1' })).toMatchObject({ decision: 'approve', why: 'sealed_recently' });
    expect(decideStop({ ...base, head: 'h2' })).toMatchObject({ decision: 'block' });
  });

  it('blocks when the sealed handoff is older than 10 minutes', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 's1', 'p');
    ageFile(path, 11 * 60_000);
    sealHandoff({ storagePath, cwd, sessionId: 's1', paneId: 'p', pid: '1', head: 'h1', now: new Date(Date.now() - 11 * 60_000) });
    expect(decideStop({ storagePath, cwd, sessionId: 's1', paneId: 'p', pid: '1', head: 'h1', enabled: true }))
      .toMatchObject({ decision: 'block' });
  });
});

describe('A7 toggle', () => {
  function writeToggle(content: string): string {
    const stateDir = tempDir('et-state-');
    mkdirSync(join(stateDir, 'settings'), { recursive: true });
    const path = join(stateDir, 'settings', 'context-handoff.json');
    writeFileSync(path, content);
    return stateDir;
  }

  it('reads the Easy Terminal setting with absent/missing/unreadable = on', () => {
    expect(readEasyTerminalToggle({})).toBe(true);
    expect(readEasyTerminalToggle({ ET_STATE_DIR: tempDir('et-empty-') })).toBe(true);
    expect(readEasyTerminalToggle({ ET_STATE_DIR: writeToggle('{"enabled": false}') })).toBe(false);
    expect(readEasyTerminalToggle({ ET_APP_STATE_DIR: writeToggle('{"enabled": false}') })).toBe(false);
    expect(readEasyTerminalToggle({ ET_STATE_DIR: writeToggle('{"thresholdPercent": 20}') })).toBe(true);
    const malformed = writeToggle('{not json');
    expect(readEasyTerminalToggle({ ET_STATE_DIR: malformed })).toBe(true);
    expect(readFileSync(join(malformed, 'settings', 'context-handoff.json'), 'utf-8')).toBe('{not json');
    // ET_STATE_DIR wins over ET_APP_STATE_DIR.
    expect(readEasyTerminalToggle({
      ET_STATE_DIR: writeToggle('{"enabled": true}'),
      ET_APP_STATE_DIR: writeToggle('{"enabled": false}'),
    })).toBe(true);
  });

  it('turns off from env or config, and Stop then approves without a marker', () => {
    expect(isHandoffEnabled(undefined, { BOOKMARK_HANDOFF: 'off' })).toBe(false);
    expect(isHandoffEnabled({ handoff: { enabled: false } }, {})).toBe(false);
    expect(isHandoffEnabled({}, {})).toBe(true);

    const { cwd, storagePath } = tempRepo();
    expect(decideStop({ storagePath, cwd, sessionId: 's', head: null, enabled: false }))
      .toMatchObject({ decision: 'approve', why: 'disabled' });
    expect(existsSync(getSessionStopMarkerPath(storagePath, 's'))).toBe(false);
  });
});

describe('A8 list / verify / kickoff', () => {
  it('prints C5 kickoff text and verifies hashes', () => {
    const { cwd, storagePath } = tempRepo();
    const path = writeHandoff(storagePath, 's1', 'p1');
    const record = sealHandoff({ storagePath, cwd, sessionId: 's1', paneId: 'p1', pid: '9', head: null })!;

    const kickoff = buildKickoff(record);
    expect(kickoff).toContain(path);
    expect(kickoff).toContain(record.sha256);
    expect(kickoff).toContain(verifyLine(path, record.sha256));

    expect(verifyHandoff(path, record.sha256)).toEqual({ ok: true, actual: record.sha256 });
    expect(verifyHandoff(path, record.sha256.toUpperCase()).ok).toBe(true);
    expect(verifyHandoff(path, '0'.repeat(64))).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(verifyHandoff(join(storagePath, 'missing.md'), record.sha256)).toMatchObject({ ok: false, reason: 'missing' });
    expect(listLineage(storagePath).map(r => r.key)).toEqual(['pane:p1:pid:9']);
    // R7: --session finds the record by session id under any key.
    expect(findLineageBySession(storagePath, 's1')?.key).toBe('pane:p1:pid:9');
    expect(findLineageBySession(storagePath, 'nobody')).toBeNull();
  });
});

describe('20 concurrent sessions in one repo', () => {
  it('each pane restores its own handoff and sha; the index lists all 20', () => {
    const { cwd, storagePath } = tempRepo();
    const sessions = Array.from({ length: 20 }, (_, i) => ({ sid: `sess-${i}-${Math.random().toString(36).slice(2, 8)}`, pane: `pane-${i}`, pid: String(1000 + i) }));
    // Deterministic interleaving: write in one order, rewrite half, seal in another.
    const writeOrder = sessions.map((_, i) => (i * 7) % 20);
    const sealOrder = sessions.map((_, i) => (i * 13 + 5) % 20);

    for (const i of writeOrder) {
      writeHandoff(storagePath, sessions[i].sid, sessions[i].pane, `Unique task ${i} for ${sessions[i].sid}`);
    }
    for (const i of sealOrder) {
      if (i % 2 === 0) {
        writeHandoff(storagePath, sessions[i].sid, sessions[i].pane, `Revised task ${i} for ${sessions[i].sid}`);
      }
      sealHandoff({ storagePath, cwd, sessionId: sessions[i].sid, paneId: sessions[i].pane, pid: sessions[i].pid, head: null });
      // Another session's stop hook running between seals must not disturb anything.
      const j = (i + 3) % 20;
      decideStop({ storagePath, cwd, sessionId: sessions[j].sid, paneId: sessions[j].pane, pid: sessions[j].pid, head: 'x', enabled: true });
    }

    for (const [i, { sid, pane, pid }] of sessions.entries()) {
      const path = getSessionHandoffPath(storagePath, sid);
      const expectedSha = sha(path);
      const message = restoreContext({ cwd, source: 'clear', sessionId: `next-${i}`, paneId: pane, pid }).systemMessage!;
      expect(message).toContain(`Session: ${sid}`);
      expect(message).toContain(`sha256: ${expectedSha}`);
      expect(message).toContain(`${i % 2 === 0 ? 'Revised' : 'Unique'} task ${i} for ${sid}`);
      expect(message).not.toContain('WARNING');
      for (const [k, other] of sessions.entries()) {
        if (k !== i) expect(message).not.toContain(`task ${k} for ${other.sid}`);
      }
    }

    const index = readFileSync(join(storagePath, 'bookmark.context.md'), 'utf-8');
    expect(index.startsWith(INDEX_MARKER)).toBe(true);
    for (const { sid } of sessions) {
      expect(index).toContain(getSessionHandoffPath(storagePath, sid));
      expect(index).toContain(`session ${sid}`);
    }
    expect(listLineage(storagePath)).toHaveLength(20);
    const leftovers = readdirSync(join(storagePath, 'lineage')).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
