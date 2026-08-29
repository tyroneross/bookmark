import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureHooks } from './configure-hooks.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configureHooks', () => {
  it('upgrades the async prompt hook to one synchronous context-check writer', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bookmark-hooks-'));
    temporaryDirectories.push(cwd);
    const settingsDirectory = join(cwd, '.claude');
    mkdirSync(settingsDirectory);
    writeFileSync(join(settingsDirectory, 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{
            type: 'command',
            command: 'npx @tyroneross/bookmark check',
            async: true,
          }],
        }],
      },
    }));

    configureHooks(cwd);

    const settings = JSON.parse(readFileSync(join(settingsDirectory, 'settings.json'), 'utf8'));
    const promptHooks = settings.hooks.UserPromptSubmit;
    expect(promptHooks).toHaveLength(1);
    expect(promptHooks[0].hooks).toEqual([{
      type: 'command',
      command: 'npx @tyroneross/bookmark context-check 2>/dev/null || echo \'{}\'',
      timeout: 10000,
    }]);
  });
});
