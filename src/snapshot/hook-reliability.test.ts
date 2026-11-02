import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Child processes must run this checkout's source, even when dist/ is absent or stale.
const compiled = mkdtempSync(join(tmpdir(), 'bookmark-hook-source-'));
const storageUrl = pathToFileURL(join(compiled, 'storage.mjs')).href;
const captureUrl = pathToFileURL(join(compiled, 'capture.mjs')).href;
beforeAll(() => {
  buildSync({
    entryPoints: {
      storage: fileURLToPath(new URL('./storage.ts', import.meta.url)),
      capture: fileURLToPath(new URL('./capture.ts', import.meta.url)),
    },
    outdir: compiled, outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
  });
});
afterAll(() => rmSync(compiled, { recursive: true, force: true }));

describe('hook durability', () => {
  it('records a PreCompact checkpoint even after an unchanged Stop capture', () => {
    const result = runCaptureScenario(`
      const stop=await captureSnapshot(options);
      const checkpoint=await captureSnapshot({...options,trigger:'pre_compact'});
      console.log(JSON.stringify({stop:stop.snapshot_id,checkpoint}));
    `);
    expect(result.checkpoint.trigger).toBe('pre_compact');
    expect(result.checkpoint.snapshot_id).not.toBe(result.stop);
    expect(result.checkpoint.prior_snapshot_id).toBe(result.stop);
    expect(result.checkpoint.tools_summary.Write).toBe(1);
  });

  it('does not reuse or accumulate a different session sharing the transcript', () => {
    const result = runCaptureScenario(`
      const first=await captureSnapshot(options);
      const second=await captureSnapshot({...options,sessionId:'other'});
      appendFileSync(transcript, JSON.stringify({type:'tool_use',name:'Write',input:{file_path:root+'/b.py',content:'y'}})+'\\n');
      const third=await captureSnapshot({...options,sessionId:'third'});
      console.log(JSON.stringify({first:first.snapshot_id,second,third}));
    `);
    expect(result.second.session_id).toBe('other');
    expect(result.second.snapshot_id).not.toBe(result.first);
    expect(result.third.session_id).toBe('third');
    expect(result.third.tools_summary.Write).toBe(2);
  });
  it('retains structural hints when later deltas edit the same file', () => {
    const result = runCaptureScenario(`
      appendFileSync(transcript, JSON.stringify({type:'tool_use',name:'Edit',input:{file_path:root+'/a.py',new_string:'export function alpha() {}'}})+'\\n');
      await captureSnapshot(options);
      appendFileSync(transcript, JSON.stringify({type:'tool_use',name:'Edit',input:{file_path:root+'/a.py',new_string:'export class Beta {}'}})+'\\n');
      await captureSnapshot(options);
      appendFileSync(transcript, JSON.stringify({type:'tool_use',name:'Edit',input:{file_path:root+'/a.py',new_string:'const value = 1;'}})+'\\n');
      console.log(JSON.stringify(await captureSnapshot(options)));
    `);
    expect(result.files_changed[0].summary).toBe('+fn alpha, +class Beta');
    expect(result.tools_summary.Edit).toBe(3);
  });
  it('preserves concurrent index transactions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bookmark-concurrent-'));
    try {
      const jobs = Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
        const snapshot = { snapshot_id: `SNAP_20261101_000000_001_000${i}`, timestamp: i,
          session_id: `s${i}`, project_path: root, trigger: 'manual', compaction_cycle: 0,
          files_changed: [], tools_summary: {} };
        const child = spawn(process.execPath, ['--input-type=module', '-e',
          `import {storeSnapshot} from ${JSON.stringify(storageUrl)}; storeSnapshot(process.argv[1], JSON.parse(process.argv[2]));`, root, JSON.stringify(snapshot)]);
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${code}`)));
      }));
      await Promise.all(jobs);
      expect(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')).snapshots).toHaveLength(8);
    } finally { rmSync(root, { recursive: true }); }
  });

  it('coalesces unchanged captures and retains cumulative Claude/Codex changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bookmark-incremental-'));
    try {
      const program = `
        import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
        import {captureSnapshot} from ${JSON.stringify(captureUrl)};
        const root=process.argv[1], transcript=root+'/session.jsonl';
        mkdirSync(root+'/.bookmark');
        writeFileSync(transcript, JSON.stringify({type:'tool_use',name:'Write',input:{file_path:root+'/a.py',content:'x'}})+'\\n');
        const options={cwd:root,transcriptPath:transcript,sessionId:'s',trigger:'session_end'};
        const a=await captureSnapshot(options), b=await captureSnapshot(options);
        appendFileSync(transcript, JSON.stringify({type:'response_item',payload:{type:'custom_tool_call',name:'apply_patch',input:'*** Add File: b.py\\n+x'}})+'\\n');
        const c=await captureSnapshot(options);
        console.log(JSON.stringify({same:a.snapshot_id===b.snapshot_id,files:c.files_changed.map(f=>f.path),tools:c.tools_summary}));`;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', program, root], {
        encoding: 'utf8', env: { ...process.env, HOME: root }, timeout: 10000
      });
      const result = JSON.parse(out);
      expect(result.same).toBe(true);
      expect(result.files.sort()).toEqual(['a.py', 'b.py']);
      expect(result.tools.Write).toBe(1);
      expect(result.tools.apply_patch).toBe(1);
    } finally { rmSync(root, { recursive: true }); }
  });
});

function runCaptureScenario(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'bookmark-capture-scenario-'));
  try {
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
      import {captureSnapshot} from ${JSON.stringify(captureUrl)};
      const root=process.argv[1], transcript=root+'/session.jsonl';
      mkdirSync(root+'/.bookmark');
      writeFileSync(transcript,JSON.stringify({type:'tool_use',name:'Write',input:{file_path:root+'/a.py',content:'x'}})+'\\n');
      const options={cwd:root,transcriptPath:transcript,sessionId:'s',trigger:'session_end'};
      ${scenario}
    `, root], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root }, timeout: 10000 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
