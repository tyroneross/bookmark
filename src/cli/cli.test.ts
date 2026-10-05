import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    const out = JSON.parse(run(['stop'], { cwd: repo, session_id: 'S1' }, { CLAUDE_PID: '77' }).stdout);
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

    expect(run(['handoff', 'verify', '--path', handoff, '--sha', record.sha256], undefined).status).toBe(0);
    expect(run(['handoff', 'verify', '--path', handoff, '--sha', '0'.repeat(64)], undefined).status).toBe(1);
    expect(JSON.parse(run(['handoff', 'list', '--json', '--cwd', repo], undefined).stdout)).toHaveLength(1);
  });
});
