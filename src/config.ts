import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { BookmarkConfig, SetupPreferences } from './types.js';

const DEFAULTS: BookmarkConfig = {
  storagePath: '.bookmark',
  thresholds: [0.20, 0.30, 0.40, 0.50, 0.60],
  maxThreshold: 0.60,
  intervalMinutes: 5,
  maxDecisions: 15,
  maxOpenItems: 10,
  maxFilesTracked: 20,
  maxErrorsTracked: 10,
  maxActiveSnapshots: 200,
  archiveAfterDays: 30,
  snapshotOnSessionEnd: true,
  restoreOnSessionStart: true,
  verboseLogging: false,
};

/**
 * Resolve the enclosing project root for a given CWD.
 *
 * Walks up from `cwd` until one of these markers is found:
 *   1. `.bookmark/` (strongest signal — an already-initialized bookmark root)
 *   2. `.git/`
 *   3. `package.json`
 *
 * Stops at `$HOME` or filesystem root and returns the original `cwd` unchanged
 * if nothing is found. This prevents bookmark commands run from a subdirectory
 * (e.g. `repo/src/foo/`) from creating or reading a stray `.bookmark/` in the
 * wrong place.
 */
export function resolveProjectRoot(cwd: string): string {
  const home = homedir();
  let dir = cwd;

  while (dir && dir !== dirname(dir)) {
    if (
      existsSync(join(dir, '.bookmark')) ||
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, 'package.json'))
    ) {
      return dir;
    }
    if (dir === home) break;
    dir = dirname(dir);
  }

  return cwd;
}

export function loadConfig(cwd?: string): BookmarkConfig {
  const config = { ...DEFAULTS };

  // Project-level config — read from resolved project root, not raw CWD,
  // so running from a subdirectory still picks up the repo's config.
  if (cwd) {
    const root = resolveProjectRoot(cwd);
    const projectConfigPath = join(root, '.bookmark', 'config.json');
    if (existsSync(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
        Object.assign(config, projectConfig);
      } catch {
        // Ignore malformed config
      }
    }
  }

  // Environment variable overrides
  if (process.env.BOOKMARK_INTERVAL) {
    config.intervalMinutes = parseInt(process.env.BOOKMARK_INTERVAL, 10) || config.intervalMinutes;
  }
  if (process.env.BOOKMARK_THRESHOLD) {
    const vals = process.env.BOOKMARK_THRESHOLD.split(',').map(Number).filter(n => !isNaN(n));
    if (vals.length > 0) config.thresholds = vals;
  }
  if (process.env.BOOKMARK_STORAGE_PATH) {
    config.storagePath = process.env.BOOKMARK_STORAGE_PATH;
  }
  if (process.env.BOOKMARK_VERBOSE === 'true') {
    config.verboseLogging = true;
  }

  return config;
}

export function getStoragePath(cwd: string, config?: BookmarkConfig): string {
  const cfg = config ?? loadConfig(cwd);
  // If storagePath is absolute (env override), use it verbatim.
  // Otherwise anchor it at the resolved project root so subdirectory calls
  // still read/write the canonical repo-level .bookmark/.
  if (cfg.storagePath.startsWith('/')) {
    return cfg.storagePath;
  }
  const root = resolveProjectRoot(cwd);
  return join(root, cfg.storagePath);
}

/**
 * Migrate data from legacy .claude/bookmarks/ to new .bookmark/ location.
 * Called during bootstrap to ensure seamless upgrade for existing projects.
 */
export function migrateLegacyStorage(cwd: string): void {
  const legacyPath = join(cwd, '.claude', 'bookmarks');
  const newPath = join(cwd, '.bookmark');

  // Only migrate if legacy path exists and new path is empty or doesn't exist
  if (!existsSync(legacyPath)) return;

  // Check if new path already has data
  if (existsSync(newPath)) {
    try {
      const files = readdirSync(newPath);
      // If new path has files (excluding .gitkeep, .DS_Store), skip migration
      const hasData = files.some(f => !f.startsWith('.'));
      if (hasData) return;
    } catch {
      return;
    }
  }

  try {
    // Create new path if it doesn't exist
    if (!existsSync(newPath)) {
      mkdirSync(newPath, { recursive: true });
    }

    // Move all files and directories from legacy to new location
    const items = readdirSync(legacyPath);
    for (const item of items) {
      const legacyItemPath = join(legacyPath, item);
      const newItemPath = join(newPath, item);

      try {
        renameSync(legacyItemPath, newItemPath);
      } catch {
        // Skip items that can't be moved
      }
    }

    // Clean up empty legacy directory
    try {
      const remaining = readdirSync(legacyPath);
      if (remaining.length === 0) {
        rmdirSync(legacyPath);

        // Also try to remove .claude if it's now empty
        const claudePath = join(cwd, '.claude');
        try {
          const claudeContents = readdirSync(claudePath);
          if (claudeContents.length === 0) {
            rmdirSync(claudePath);
          }
        } catch {
          // .claude has other content, leave it
        }
      }
    } catch {
      // Legacy dir not empty or can't be removed, that's fine
    }
  } catch {
    // Migration failed, but that's okay — user can manually move if needed
  }
}

export function writeConfig(cwd: string, prefs: SetupPreferences): void {
  const configDir = join(cwd, '.bookmark');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const configPath = join(configDir, 'config.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Overwrite malformed config
    }
  }

  const merged = {
    ...existing,
    intervalMinutes: prefs.intervalMinutes,
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}
