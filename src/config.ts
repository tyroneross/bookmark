import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BookmarkConfig, SetupPreferences } from './types.js';

const DEFAULTS: BookmarkConfig = {
  storagePath: '.claude/bookmarks',
  thresholds: [0.20, 0.30, 0.40, 0.50, 0.60],
  maxThreshold: 0.60,
  intervalMinutes: 20,
  contextLimitTokens: 200_000,
  charsPerToken: 4,
  maxDecisions: 15,
  maxOpenItems: 10,
  maxFilesTracked: 20,
  maxErrorsTracked: 10,
  summaryTokenBudget: 1000,
  maxActiveSnapshots: 50,
  archiveAfterDays: 30,
  snapshotOnSessionEnd: true,
  restoreOnSessionStart: true,
  smartDefault: false,
  verboseLogging: false,
};

export function loadConfig(cwd?: string): BookmarkConfig {
  const config = { ...DEFAULTS };

  // Project-level config
  if (cwd) {
    const projectConfigPath = join(cwd, '.claude', 'bookmarks', 'config.json');
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
  if (process.env.BOOKMARK_CONTEXT_LIMIT) {
    config.contextLimitTokens = parseInt(process.env.BOOKMARK_CONTEXT_LIMIT, 10) || config.contextLimitTokens;
  }
  if (process.env.BOOKMARK_SMART === 'true') {
    config.smartDefault = true;
  }
  if (process.env.BOOKMARK_VERBOSE === 'true') {
    config.verboseLogging = true;
  }

  return config;
}

export function getStoragePath(cwd: string, config?: BookmarkConfig): string {
  const cfg = config ?? loadConfig(cwd);
  return join(cwd, cfg.storagePath);
}

export function writeConfig(cwd: string, prefs: SetupPreferences): void {
  const configDir = join(cwd, '.claude', 'bookmarks');
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
    smartDefault: prefs.smartDefault,
  };

  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
}
