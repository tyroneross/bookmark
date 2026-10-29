import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, type HostManifest } from '../host/manifest.js';
import { isBookmarkEntry, mergeHookConfig, planEntries, writeJsonConfig, type HookConfig, type InstallEntry } from '../host/install.js';

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

/** Claude Code hook entries, generated from hosts/claude.json (the single source of host facts). */
function claudePlan(): { manifest: HostManifest; entries: InstallEntry[] } {
  const manifest = loadManifest('claude');
  if (!manifest) throw new Error('hosts/claude.json is missing from the Bookmark package');
  return { manifest, entries: planEntries(manifest) };
}

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

function isBookmarkHook(hookGroup: SettingsHook): boolean {
  return isBookmarkEntry(hookGroup);
}

/**
 * Configure hooks and plugin registration in the project's .claude/settings.json.
 * All hooks are command-type. One synchronous `context-check` hook handles
 * interval capture and token alerts through a single state writer.
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

  // ─── Hook configuration (shared merge writer) ───
  const { manifest, entries } = claudePlan();
  const { merged } = mergeHookConfig(settings as HookConfig, manifest, entries);
  writeJsonConfig(settingsPath, merged, { backup: false });
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

  const { manifest, entries } = claudePlan();
  const { merged, changed } = mergeHookConfig(settings as HookConfig, manifest, entries);
  if (changed) writeJsonConfig(settingsPath, merged, { backup: false });
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
