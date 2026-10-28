import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../util/atomic-write.js';

// Compiles the real CLI once and drives it the way hooks do (JSON on stdin).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(repoRoot, `.vitest-cli-dist-${process.pid}`);
const cli = join(outDir, 'cli', 'index.js');
let sandbox: string;

beforeAll(() => {
  execFileSync(process.execPath, [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', join(repoRoot, 'tsconfig.json'),
    '--outDir', outDir, '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false',
  ], { stdio: 'pipe' });
  sandbox = mkdtempSync(join(tmpdir(), 'bookmark-cli-'));
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function run(args: string[], input: unknown, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: join(sandbox, 'home'), ...env },
    timeout: 20_000,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

function newRepo(name: string): string {
  const repo = join(sandbox, name);
  mkdirSync(join(repo, '.bookmark'), { recursive: true });
  return repo;
}

describe('R6 hooks without a session id', () => {
  it('stop approves and context-check prints {} without writing anything', () => {
    const repo = newRepo('no-session');
    const before = readdirSync(join(repo, '.bookmark'));
    expect(JSON.parse(run(['stop'], { cwd: repo }).stdout)).toEqual({ decision: 'approve' });
    expect(JSON.parse(run(['context-check'], { cwd: repo, transcript_path: join(repo, 't.jsonl') }).stdout)).toEqual({});
    expect(readdirSync(join(repo, '.bookmark'))).toEqual(before);
    expect(existsSync(join(repo, '.bookmark', 'sessions'))).toBe(false);
  });

  it('stop with a session id blocks once and names only the per-session file', () => {
    const repo = newRepo('with-session');
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'S1', 160_000);
    const out = JSON.parse(run(['stop'], { cwd: repo, session_id: 'S1', transcript_path: transcript }, { CLAUDE_PID: '77' }).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(join(repo, '.bookmark', 'sessions', 'S1', 'handoff.md'));
    expect(out.reason).not.toContain('bookmark.context.md');
  });
});

describe('R7 / A8 handoff CLI', () => {
  it('kickoff --session finds the record under any key; verify checks the hash', () => {
    const repo = newRepo('kickoff');
    const handoff = join(repo, '.bookmark', 'sessions', 'S9', 'handoff.md');
    writeFileAtomic(handoff, '# handoff\n');
    const sealed = run(['handoff', 'seal', '--session', 'S9', '--pane', 'P', '--pid', '42', '--cwd', repo], undefined);
    expect(sealed.status).toBe(0);
    const record = JSON.parse(sealed.stdout);
    expect(record.key).toBe('pane:P:pid:42');

    const kickoff = run(['handoff', 'kickoff', '--session', 'S9', '--cwd', repo], undefined);
    expect(kickoff.status).toBe(0);
    expect(kickoff.stdout).toContain(`Verify first: \`shasum -a 256 '${handoff}'\` must print ${record.sha256}.`);
    expect(run(['handoff', 'kickoff', '--pane', 'P', '--pid', '42', '--cwd', repo], undefined).status).toBe(0);
    expect(run(['handoff', 'kickoff', '--session', 'nobody', '--cwd', repo], undefined).status).toBe(1);
    // --pane without --pid: newest record sealed from that pane.
    const byPane = run(['handoff', 'kickoff', '--pane', 'P', '--cwd', repo], undefined);
    expect(byPane.status).toBe(0);
    expect(byPane.stdout).toContain(record.sha256);
    expect(run(['handoff', 'kickoff', '--pane', 'nope', '--cwd', repo], undefined).status).toBe(1);

    expect(run(['handoff', 'verify', '--path', handoff, '--sha', record.sha256], undefined).status).toBe(0);
    expect(run(['handoff', 'verify', '--path', handoff, '--sha', '0'.repeat(64)], undefined).status).toBe(1);
    expect(JSON.parse(run(['handoff', 'list', '--json', '--cwd', repo], undefined).stdout)).toHaveLength(1);
  });
});

// ─── Stop fires at every turn end: block only near the context limit ───

/** One assistant usage record; claude-opus-4-5 has a 200K window. */
function writeTranscript(dir: string, sessionId: string, usedTokens: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}-${usedTokens}.jsonl`);
  const lines = [
    { type: 'user', sessionId, message: { role: 'user', content: 'hello' } },
    {
      type: 'assistant',
      sessionId,
      message: { model: 'claude-opus-4-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: usedTokens, output_tokens: 0 } },
    },
  ];
  writeFileAtomic(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return path;
}

function newGitRepo(name: string): string {
  const repo = join(sandbox, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

describe('Stop at an ordinary turn end', () => {
  it('(1) below threshold: approves, writes no marker, creates no .bookmark in a non-repo folder', () => {
    const plain = join(sandbox, 'plain-folder', 'analysis');
    mkdirSync(plain, { recursive: true });
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'T1', 20_000);
    const out = JSON.parse(run(['stop'], { cwd: plain, session_id: 'T1', transcript_path: transcript }).stdout);
    expect(out).toEqual({ decision: 'approve' });
    expect(existsSync(join(plain, '.bookmark'))).toBe(false);
    expect(existsSync(join(sandbox, 'plain-folder', '.bookmark'))).toBe(false);

    const repo = newGitRepo('below-threshold-repo');
    const repoOut = JSON.parse(run(['stop'], { cwd: repo, session_id: 'T1', transcript_path: transcript }).stdout);
    expect(repoOut).toEqual({ decision: 'approve' });
    expect(existsSync(join(repo, '.bookmark', 'sessions', 'T1', 'stop-requested'))).toBe(false);
  });

  it('(1b) no measurable usage (no transcript): approves', () => {
    const repo = newGitRepo('no-transcript-repo');
    const out = JSON.parse(run(['stop'], { cwd: repo, session_id: 'T0' }).stdout);
    expect(out).toEqual({ decision: 'approve' });
  });

  it('(2) at/above threshold with a stale handoff: blocks once, then approves', () => {
    const repo = newGitRepo('above-threshold-repo');
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'T2', 160_000);
    const first = JSON.parse(run(['stop'], { cwd: repo, session_id: 'T2', transcript_path: transcript }).stdout);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(join(repo, '.bookmark', 'sessions', 'T2', 'handoff.md'));
    const second = JSON.parse(run(['stop'], { cwd: repo, session_id: 'T2', transcript_path: transcript }).stdout);
    expect(second).toEqual({ decision: 'approve' });
  });

  it('(2b) BOOKMARK_STOP_MODE=every-turn restores the strict block below threshold', () => {
    const repo = newGitRepo('strict-mode-repo');
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'T5', 20_000);
    const out = JSON.parse(run(['stop'], { cwd: repo, session_id: 'T5', transcript_path: transcript }, { BOOKMARK_STOP_MODE: 'every-turn' }).stdout);
    expect(out.decision).toBe('block');
  });

  it('(3) cwd in a repo subfolder: storage resolves to the repo root, no stray .bookmark', () => {
    const repo = newGitRepo('subfolder-repo');
    const sub = join(repo, 'analysis', 'diagram');
    mkdirSync(sub, { recursive: true });
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'T3', 160_000);
    const out = JSON.parse(run(['stop'], { cwd: sub, session_id: 'T3', transcript_path: transcript }).stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(join(repo, '.bookmark', 'sessions', 'T3', 'handoff.md'));
    expect(existsSync(join(sub, '.bookmark'))).toBe(false);
    expect(existsSync(join(repo, 'analysis', '.bookmark'))).toBe(false);
  });

  it('(4) cwd = $HOME with a scope:home pointer: approves and leaves the pointer untouched', () => {
    const home = join(sandbox, 'home');
    const pointerPath = join(home, '.bookmark', 'bookmark.context.md');
    const pointer = [
      '# Active Work Pointer (home-scoped bookmark)', '', '<!-- BOOKMARK_IDENTITY', 'scope: home',
      'project: POINTER_ONLY', 'points_to_project: example', 'points_to_canonical: /tmp/example/.bookmark/bookmark.context.md',
      '-->', '',
    ].join('\n');
    writeFileAtomic(pointerPath, pointer);
    const before = readdirSync(join(home, '.bookmark')).sort();
    const transcript = writeTranscript(join(sandbox, 'transcripts'), 'T4', 160_000);
    const out = JSON.parse(run(['stop'], { cwd: home, session_id: 'T4', transcript_path: transcript }).stdout);
    expect(out).toEqual({ decision: 'approve' });
    expect(readFileSync(pointerPath, 'utf-8')).toBe(pointer);
    expect(readdirSync(join(home, '.bookmark')).sort()).toEqual(before);
  });
});
