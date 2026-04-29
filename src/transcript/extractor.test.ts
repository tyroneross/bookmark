/**
 * D1 regression: file paths in snapshot output land relative to the
 * supplied `projectPath`, not absolute. Stops the "stale-after-move"
 * problem (e.g. /Users/.../Desktop/git-folder → /Users/.../dev/git-folder).
 */

import { describe, it, expect } from 'vitest';
import { extractFilesAndTools } from './extractor.js';
import type { TranscriptEntry } from '../types.js';

function toolUse(name: string, input: Record<string, unknown>): TranscriptEntry {
  return {
    type: 'tool_use',
    tool_name: name,
    tool_input: input,
  } as TranscriptEntry;
}

describe('extractFilesAndTools — relative paths', () => {
  it('rewrites absolute paths under projectPath to relative', () => {
    const entries = [
      toolUse('Edit', {
        file_path: '/Users/me/dev/git-folder/myapp/src/foo.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ];
    const out = extractFilesAndTools(entries, {
      projectPath: '/Users/me/dev/git-folder/myapp',
    });
    expect(out.files_changed).toHaveLength(1);
    expect(out.files_changed[0].path).toBe('src/foo.ts');
  });

  it('leaves paths outside projectPath untouched (filtered earlier in the pipeline)',
    () => {
      const entries = [
        toolUse('Write', {
          file_path: '/Users/me/dev/git-folder/myapp/x.md',
          content: 'x',
        }),
      ];
      const out = extractFilesAndTools(entries, {
        projectPath: '/Users/me/dev/git-folder/myapp',
      });
      expect(out.files_changed[0].path).toBe('x.md');
    });

  it('preserves the absolute path when no projectPath is supplied', () => {
    const entries = [
      toolUse('Edit', {
        file_path: '/abs/path/file.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ];
    const out = extractFilesAndTools(entries);
    expect(out.files_changed[0].path).toBe('/abs/path/file.ts');
  });

  it('passes through already-relative paths unchanged', () => {
    const entries = [
      toolUse('Edit', {
        file_path: 'src/foo.ts',
        old_string: 'a',
        new_string: 'b',
      }),
    ];
    const out = extractFilesAndTools(entries);
    expect(out.files_changed[0].path).toBe('src/foo.ts');
  });
});
