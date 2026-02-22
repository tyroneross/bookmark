import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}

interface SettingsHook {
  matcher: string;
  hooks: HookEntry[];
}

interface Settings {
  hooks?: Record<string, SettingsHook[]>;
  [key: string]: unknown;
}

const BOOKMARK_HOOKS: Record<string, SettingsHook> = {
  PreCompact: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: 'npx @tyroneross/bookmark snapshot --trigger pre_compact 2>/dev/null || true',
      timeout: 30000,
      async: true,
    }],
  },
  SessionStart: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: 'npx @tyroneross/bookmark restore 2>/dev/null || echo \'{}\'',
      timeout: 5000,
    }],
  },
  UserPromptSubmit: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: 'npx @tyroneross/bookmark check 2>/dev/null || true',
      timeout: 3000,
      async: true,
    }],
  },
  Stop: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: 'npx @tyroneross/bookmark snapshot --trigger session_end 2>/dev/null || true',
      timeout: 15000,
    }],
  },
};

const BOOKMARK_MARKER = '@tyroneross/bookmark';

/**
 * Configure hooks in the project's .claude/settings.json.
 * Adds bookmark hooks without duplicating or overwriting existing hooks.
 */
export function configureHooks(cwd: string): void {
  const settingsDir = join(cwd, '.claude');
  const settingsPath = join(settingsDir, 'settings.json');

  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [event, hookConfig] of Object.entries(BOOKMARK_HOOKS)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Check if bookmark hook already exists
    const exists = settings.hooks[event].some(h =>
      h.hooks.some(hh => hh.command?.includes(BOOKMARK_MARKER))
    );

    if (!exists) {
      settings.hooks[event].push(hookConfig);
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Remove bookmark hooks from settings.json.
 */
export function removeHooks(cwd: string): void {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(h =>
        !h.hooks.some(hh => hh.command?.includes(BOOKMARK_MARKER))
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Silent
  }
}
