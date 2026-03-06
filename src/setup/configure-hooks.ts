import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

interface HookEntry {
  type: string;
  command?: string;
  prompt?: string;
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

const BOOKMARK_HOOKS: Record<string, SettingsHook> = {
  Stop: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark stop 2>/dev/null || echo '{"decision": "approve"}'`,
      timeout: 10000,
    }],
  },
  PreCompact: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark precompact 2>/dev/null || echo '{}'`,
      timeout: 10000,
    }],
  },
  SessionStart: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark restore 2>/dev/null || echo '{}'`,
      timeout: 5000,
    }],
  },
  UserPromptSubmit: {
    matcher: '',
    hooks: [{
      type: 'command',
      command: `npx @tyroneross/bookmark check 2>/dev/null || true`,
      timeout: 3000,
      async: true,
    }],
  },
};

const BOOKMARK_MARKER = '@tyroneross/bookmark';
const BOOKMARK_PROMPT_MARKER = '.claude/bookmarks/CONTEXT.md';

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
 * Check if a hook group contains a bookmark hook (command or prompt type).
 */
function isBookmarkHook(hookGroup: SettingsHook): boolean {
  return hookGroup.hooks.some(hh =>
    hh.command?.includes(BOOKMARK_MARKER) ||
    hh.prompt?.includes(BOOKMARK_PROMPT_MARKER)
  );
}

/**
 * Configure hooks and plugin registration in the project's .claude/settings.json.
 * All hooks are command-type — Stop and PreCompact use CLI commands that
 * output JSON decisions (block/approve) and systemMessages.
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

    const existingIdx = settings.hooks[event].findIndex(isBookmarkHook);

    if (existingIdx === -1) {
      // No existing bookmark hook — add the new one
      settings.hooks[event].push(hookConfig);
    } else {
      // Replace existing bookmark hook (upgrades old prompt hooks to command hooks)
      settings.hooks[event][existingIdx] = hookConfig;
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Configure hooks in the GLOBAL ~/.claude/settings.json.
 * This makes bookmark fire in every project without per-project setup.
 * Merges with existing hooks — never overwrites user's other hooks.
 */
export function configureGlobalHooks(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return;

  const settingsDir = join(home, '.claude');
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

  let changed = false;
  for (const [event, hookConfig] of Object.entries(BOOKMARK_HOOKS)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    const existingIdx = settings.hooks[event].findIndex(isBookmarkHook);

    if (existingIdx === -1) {
      // No existing bookmark hook — append (don't replace user's other hooks)
      settings.hooks[event].push(hookConfig);
      changed = true;
    } else {
      // Update existing bookmark hook in place
      const existing = JSON.stringify(settings.hooks[event][existingIdx]);
      const updated = JSON.stringify(hookConfig);
      if (existing !== updated) {
        settings.hooks[event][existingIdx] = hookConfig;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

/**
 * Remove bookmark hooks from the GLOBAL ~/.claude/settings.json.
 */
export function removeGlobalHooks(): void {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return;
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return;

  try {
    const settings: Settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    if (!settings.hooks) return;

    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(h => !isBookmarkHook(h));
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Silent
  }
}

/**
 * Remove bookmark hooks and plugin entry from a project's settings.json.
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

    // Remove hooks (both command and prompt types)
    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        settings.hooks[event] = settings.hooks[event].filter(h => !isBookmarkHook(h));
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
