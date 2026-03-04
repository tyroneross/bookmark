import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureHooks } from './configure-hooks.js';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PLUGIN_VERSION = '0.2.1';

// ─── Plugin Registration ───

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

/**
 * Register bookmark in Claude Code's installed_plugins.json.
 * This is required for skill/command discovery — the symlink alone isn't enough.
 */
export function registerPlugin(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return false;

  const pluginsDir = join(home, '.claude', 'plugins');
  const installedPath = join(pluginsDir, 'installed_plugins.json');
  const pluginLinkPath = join(pluginsDir, 'bookmark');

  // Resolve the actual install path (follow symlink if present)
  let installPath = pluginLinkPath;
  try {
    if (existsSync(pluginLinkPath)) {
      installPath = realpathSync(pluginLinkPath);
    }
  } catch { /* use link path */ }

  // Read existing installed_plugins.json
  let installed: InstalledPlugins = { version: 2, plugins: {} };
  if (existsSync(installedPath)) {
    try {
      installed = JSON.parse(readFileSync(installedPath, 'utf-8'));
    } catch {
      installed = { version: 2, plugins: {} };
    }
  }

  const key = 'bookmark@local';
  const now = new Date().toISOString();

  // Check if already registered
  if (installed.plugins[key]) {
    // Update version and lastUpdated
    installed.plugins[key][0].version = PLUGIN_VERSION;
    installed.plugins[key][0].lastUpdated = now;
    installed.plugins[key][0].installPath = installPath;
  } else {
    // Add new entry
    installed.plugins[key] = [{
      scope: 'user',
      installPath,
      version: PLUGIN_VERSION,
      installedAt: now,
      lastUpdated: now,
    }];
  }

  try {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the bookmark symlink exists in ~/.claude/plugins/.
 * Creates it pointing to bookmark's root directory (resolved from this file's location).
 */
function ensurePluginSymlink(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return false;

  const pluginsDir = join(home, '.claude', 'plugins');
  const linkPath = join(pluginsDir, 'bookmark');

  // Already exists (symlink or directory)
  if (existsSync(linkPath)) return true;

  try {
    // Resolve bookmark's root: this file is at dist/setup/auto-setup.js → root is ../..
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const bookmarkRoot = join(thisDir, '..', '..');

    // Verify it's actually bookmark
    const pkgPath = join(bookmarkRoot, 'package.json');
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.name !== '@tyroneross/bookmark') return false;

    mkdirSync(pluginsDir, { recursive: true });
    symlinkSync(bookmarkRoot, linkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the project root — npm sets INIT_CWD to the original working directory.
 */
function findProjectRoot(): string {
  if (process.env.INIT_CWD) {
    return process.env.INIT_CWD;
  }
  return process.cwd();
}

// ─── Core Setup (reusable) ───

/**
 * Check if bookmark hooks are already configured in a project.
 */
export function isProjectConfigured(cwd: string): boolean {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return false;
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    return content.includes('@tyroneross/bookmark');
  } catch {
    return false;
  }
}

/**
 * Set up bookmark in a project directory.
 * Creates storage dirs, configures hooks, injects gitignore and CLAUDE.md.
 * Returns list of steps completed. Silent (no console output) — caller decides output.
 */
export function setupProject(cwd: string): string[] {
  const steps: string[] = [];

  // 1. Ensure storage directories
  const bookmarkPath = join(cwd, '.claude', 'bookmarks');
  mkdirSync(join(bookmarkPath, 'snapshots'), { recursive: true });
  mkdirSync(join(bookmarkPath, 'archive'), { recursive: true });
  steps.push('Created .claude/bookmarks/ directories');

  // 2. Configure hooks in settings.json
  try {
    configureHooks(cwd);
    steps.push('Configured 4 hooks (PreCompact, SessionStart, UserPromptSubmit, Stop)');
  } catch { /* silently skip */ }

  // 3. Add .claude/bookmarks/ to .gitignore
  try {
    const added = injectGitignore(cwd);
    if (added) {
      steps.push('Added .claude/bookmarks/ to .gitignore');
    }
  } catch { /* silently skip */ }

  // 4. Inject CLAUDE.md section
  try {
    const updated = injectClaudeMd(cwd);
    if (updated) {
      steps.push('Updated .claude/CLAUDE.md with bookmark docs');
    }
  } catch { /* silently skip */ }

  // 5. Register plugin for skill/command discovery
  try {
    ensurePluginSymlink();
    if (registerPlugin()) {
      steps.push('Registered bookmark plugin for Claude Code discovery');
    }
  } catch { /* silently skip */ }

  return steps;
}

/**
 * Auto-bootstrap: silently configure hooks if bookmark CLI runs in an unconfigured project.
 * Called at the top of CLI commands. No-op if already configured.
 */
export function ensureProjectBootstrapped(cwd: string): void {
  if (isProjectConfigured(cwd)) return;

  // Skip if no package.json (not a real project)
  if (!existsSync(join(cwd, 'package.json'))) return;

  try {
    setupProject(cwd);
  } catch {
    // Silent — don't break the command
  }
}

// ─── Postinstall Entry Point ───

/**
 * Auto-setup runs on npm postinstall.
 * Sets up hooks, CLAUDE.md injection, and storage directories.
 * Shows visible output so users know setup succeeded.
 */
function autoSetup(): void {
  // Skip in CI or when disabled
  if (process.env.CI || process.env.BOOKMARK_SKIP_SETUP === 'true') {
    return;
  }

  const projectRoot = findProjectRoot();
  const isGlobal = process.env.npm_config_global === 'true';
  const hasProject = projectRoot !== '/' && existsSync(join(projectRoot, 'package.json'));

  // Global install with no project context
  if (isGlobal && !hasProject) {
    // Still register plugin for discovery even without a project
    try {
      ensurePluginSymlink();
      registerPlugin();
    } catch { /* silent */ }
    console.log(`\n  ${GREEN}Bookmark${RESET} installed globally.`);
    console.log(`  Hooks will auto-configure when you use ${CYAN}/bookmark:activate${RESET} in a Claude Code session.\n`);
    return;
  }

  // No project found
  if (!hasProject) {
    return;
  }

  // Skip if this is our own package (development mode)
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    if (pkg.name === '@tyroneross/bookmark') return;
  } catch { /* ignore */ }

  // Global install FROM a project directory — configure that project
  // Local install — configure the project

  console.log(`\n  ${GREEN}Bookmark${RESET} — Setting up context snapshots\n`);

  try {
    const steps = setupProject(projectRoot);

    for (const step of steps) {
      console.log(`  ${GREEN}+${RESET} ${step}`);
    }

    console.log();
    console.log(`  ${GREEN}Ready.${RESET} Context snapshots are now active.`);
    console.log();
    console.log(`  ${DIM}How it works:${RESET}`);
    console.log(`  ${DIM}  - Snapshots captured automatically before compaction and on intervals${RESET}`);
    console.log(`  ${DIM}  - Context restored when you start a new session${RESET}`);
    console.log(`  ${DIM}  - Use${RESET} ${CYAN}/bookmark:snapshot${RESET} ${DIM}for manual snapshots${RESET}`);
    console.log();

  } catch (error) {
    // Don't fail npm install
    console.warn(`  Setup skipped: ${(error as Error).message}\n`);
  }
}

// ─── Inject Helpers ───

function injectGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, '.gitignore');
  const entry = '.claude/bookmarks/';

  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
    if (content.includes(entry)) return false;
    if (!content.endsWith('\n')) content += '\n';
  }

  content += `\n# Bookmark snapshot data\n${entry}\n`;
  writeFileSync(gitignorePath, content, 'utf-8');
  return true;
}

function injectClaudeMd(cwd: string): boolean {
  const claudeMdPath = join(cwd, '.claude', 'CLAUDE.md');
  const marker = '## Bookmark — Context Snapshots';

  let content = '';
  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, 'utf-8');
    // Don't duplicate
    if (content.includes(marker)) return false;
    content += '\n\n';
  } else {
    // Ensure .claude dir exists
    mkdirSync(join(cwd, '.claude'), { recursive: true });
  }

  content += `${marker}

This project uses @tyroneross/bookmark for context snapshots.

**Automatic behavior:**
- Snapshots captured before compaction and on session end
- CONTEXT.md restored on session start (~400 tokens, trailhead with routing)
- Trail files (decisions.md, files.md) available for deeper context via Read tool
- No external API calls — you interpret the trails naturally

**Trail routing:**
- \`CONTEXT.md\` has intent, progress, and pointers to trail files
- Follow \`trails/decisions.md\` for timestamped decision history
- Follow \`trails/files.md\` for cumulative file change details
- Only read trails if the trailhead isn't enough

**Commands:**
- \`/bookmark:snapshot\` — Manual snapshot
- \`/bookmark:restore\` — Restore from a snapshot
- \`/bookmark:status\` — Show snapshot stats
- \`/bookmark:list\` — List all snapshots
`;

  writeFileSync(claudeMdPath, content, 'utf-8');
  return true;
}

// Only run auto-setup when executed as postinstall script, not when imported
const isPostinstall = process.env.npm_lifecycle_event === 'postinstall' ||
  process.argv[1]?.endsWith('auto-setup.js');
if (isPostinstall) {
  autoSetup();
}
