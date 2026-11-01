import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const storageUrl = new URL('../../dist/snapshot/storage.js', import.meta.url).href;
const captureUrl = new URL('../../dist/snapshot/capture.js', import.meta.url).href;

describe('hook durability', () => {
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
