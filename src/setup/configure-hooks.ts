import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
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
  plugins?: string[];
  hooks?: Record<string, SettingsHook[]>;
  [key: string]: unknown;
}

// Error log path — uses CLAUDE_PROJECT_DIR if available, falls back to project .claude/bookmarks/
const ERROR_LOG = '"${CLAUDE_PROJECT_DIR:-.}/.claude/bookmarks/.errors.log"';

const BOOKMARK_HOOKS: Record<string, SettingsHook> = {
  PreCompact: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark snapshot --trigger pre_compact 2>>${ERROR_LOG} || true`,
      timeout: 30000,
      async: true,
    }],
  },
  SessionStart: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark restore 2>>${ERROR_LOG} || echo '{}'`,
      timeout: 5000,
    }],
  },
  UserPromptSubmit: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark check 2>>${ERROR_LOG} || true`,
      timeout: 3000,
      async: true,
    }],
  },
  Stop: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark snapshot --trigger session_end 2>>${ERROR_LOG} || true`,
      timeout: 15000,
    }],
  },
};

const BOOKMARK_MARKER = '@tyroneross/bookmark';

/**
 * Resolve the plugin path for the settings.json plugins array.
 * Checks for local npm install first, then global symlink.
 */
function resolvePluginPath(cwd: string): string | null {
  // Check local npm install
  const localPlugin = join(cwd, 'node_modules', '@tyroneross', 'bookmark', '.claude-plugin');
  if (existsSync(localPlugin)) {
    return 'node_modules/@tyroneross/bookmark/.claude-plugin';
  }

  // Check global symlink
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const globalLink = join(home, '.claude', 'plugins', 'bookmark');
    if (existsSync(globalLink)) {
      try {
        const resolved = realpathSync(globalLink);
        return join(resolved, '.claude-plugin');
      } catch { /* fall through */ }
    }
  }

  return null;
}

/**
 * Configure hooks and plugin registration in the project's .claude/settings.json.
 * Adds bookmark hooks and plugin path without duplicating or overwriting existing entries.
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

  // ─── Plugin registration in settings.plugins ───
  if (!settings.plugins) {
    settings.plugins = [];
  }

  const pluginPath = resolvePluginPath(cwd);
  if (pluginPath) {
    const alreadyRegistered = settings.plugins.some(p => p.includes('bookmark'));
    if (!alreadyRegistered) {
      settings.plugins.push(pluginPath);
    }
  }

  // ─── Hook configuration ───
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
    } else {
      // Update existing hooks to use error logging instead of /dev/null
      for (const hookGroup of settings.hooks[event]) {
        for (const hook of hookGroup.hooks) {
          if (hook.command?.includes(BOOKMARK_MARKER) && hook.command.includes('2>/dev/null')) {
            hook.command = hook.command.replace(
              /2>\/dev\/null/g,
              `2>>${ERROR_LOG}`
            );
          }
        }
      }
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Remove bookmark hooks and plugin entry from settings.json.
 */
export function removeHooks(cwd: string): void {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // Remove from plugins array
    if (settings.plugins) {
      settings.plugins = settings.plugins.filter(p => !p.includes('bookmark'));
      if (settings.plugins.length === 0) {
        delete settings.plugins;
      }
    }

    // Remove hooks
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        settings.hooks[event] = settings.hooks[event].filter(h =>
          !h.hooks.some(hh => hh.command?.includes(BOOKMARK_MARKER))
        );
        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Silent
  }
}
