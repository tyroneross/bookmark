import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureHooks, configureGlobalHooks } from './configure-hooks.js';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PLUGIN_VERSION = '0.3.2';

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
 * Auto-bootstrap: silently configure storage if bookmark CLI runs in an unconfigured project.
 * Called at the top of CLI commands. Creates .claude/bookmarks/ if needed.
 * Works in any directory — not just npm projects.
 */
export function ensureProjectBootstrapped(cwd: string): void {
  // Clean stale pipeline-generated CONTEXT.md on upgrade
  cleanStaleContextMd(cwd);

  // Ensure storage dirs exist (lazy creation on first hook invocation)
  const bookmarkPath = join(cwd, '.claude', 'bookmarks');
  if (!existsSync(bookmarkPath)) {
    try {
      mkdirSync(join(bookmarkPath, 'snapshots'), { recursive: true });
    } catch {
      // Silent — don't break the command
    }
  }
}

/**
 * Detect and remove pipeline-generated CONTEXT.md files that contain
 * only empty metadata (the overwrite bug from v0.3.0).
 * These start with [Bookmark Context — and contain Intent: Unknown or
 * User feedback: positive with no real task content.
 */
function cleanStaleContextMd(cwd: string): void {
  const contextPath = join(cwd, '.claude', 'bookmarks', 'CONTEXT.md');
  if (!existsSync(contextPath)) return;

  try {
    const content = readFileSync(contextPath, 'utf-8');

    // Only clean files that match the pipeline-generated format
    if (!content.startsWith('[Bookmark Context')) return;

    // Check for signs of empty pipeline output
    const hasNoRealContent =
      (content.includes('Intent:') && content.includes('Unknown')) ||
      (content.includes('**User feedback:** positive') && !content.includes('**Intent:**')) ||
      (content.includes('**User feedback:** positive') && content.includes('Intent: Unknown'));

    // Don't delete if there's substantial content (Claude may have written useful stuff)
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('>') && !l.startsWith('['));
    const contentLines = lines.filter(l =>
      !l.startsWith('**Trails**') &&
      !l.startsWith('- `') &&
      !l.startsWith('Resume the task') &&
      !l.startsWith('**User feedback:**') &&
      !l.startsWith('**Intent:** Unknown') &&
      !l.startsWith('**Progress:** Unknown')
    );

    if (hasNoRealContent && contentLines.length <= 2) {
      unlinkSync(contextPath);
    }
  } catch {
    // Silent — don't break bootstrap
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

  // Skip if this is our own package (development mode)
  if (hasProject) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
      if (pkg.name === '@tyroneross/bookmark') return;
    } catch { /* ignore */ }
  }

  console.log(`\n  ${GREEN}Bookmark${RESET} — Setting up context snapshots\n`);

  const steps: string[] = [];

  // 1. Always register global hooks — this is what makes it "just work"
  try {
    configureGlobalHooks();
    steps.push('Registered hooks globally (SessionStart, Stop, PreCompact, UserPromptSubmit)');
  } catch { /* silent */ }

  // 2. Plugin symlink + registry for skill/command discovery
  try {
    ensurePluginSymlink();
    if (registerPlugin()) {
      steps.push('Registered plugin for Claude Code discovery');
    }
  } catch { /* silent */ }

  // 3. Inject into global CLAUDE.md so Claude always knows about bookmark
  try {
    if (injectGlobalClaudeMd()) {
      steps.push('Added bookmark docs to ~/.claude/CLAUDE.md');
    }
  } catch { /* silent */ }

  // 4. If we're in a project, also configure it locally
  if (hasProject) {
    try {
      const projectSteps = setupProject(projectRoot);
      steps.push(...projectSteps);
    } catch { /* silent */ }
  }

  for (const step of steps) {
    console.log(`  ${GREEN}+${RESET} ${step}`);
  }

  console.log();
  console.log(`  ${GREEN}Ready.${RESET} Bookmark is now active in all projects.`);
  console.log(`  ${DIM}Context auto-saved on stop, auto-restored on start. No setup needed per project.${RESET}`);
  console.log();
}

// ─── Inject Helpers ───

/**
 * Register the bookmark MCP server in ~/.claude/.mcp.json.
 * This makes bookmark tools (snapshot, restore, status, list, show)
 * available to Claude in every project without per-project config.
 */
function registerGlobalMcp(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return false;

  const mcpPath = join(home, '.claude', '.mcp.json');

  let mcpConfig: Record<string, unknown> = {};
  if (existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    } catch {
      mcpConfig = {};
    }
  }

  // Check if already registered
  const mcpServers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
  if (mcpServers.bookmark) return false;

  // Resolve the server path from the plugin symlink or install location
  const pluginLink = join(home, '.claude', 'plugins', 'bookmark');
  let serverPath: string;
  try {
    const resolved = existsSync(pluginLink) ? realpathSync(pluginLink) : '';
    serverPath = resolved ? join(resolved, 'dist', 'mcp', 'server.js') : '';
  } catch {
    serverPath = '';
  }

  if (!serverPath || !existsSync(serverPath)) return false;

  mcpServers.bookmark = {
    command: 'node',
    args: [serverPath],
  };
  mcpConfig.mcpServers = mcpServers;

  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
  return true;
}

/**
 * Inject bookmark docs into ~/.claude/CLAUDE.md (global).
 * This ensures Claude always knows about bookmark regardless of project.
 */
function injectGlobalClaudeMd(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return false;

  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  const marker = '## Bookmark';

  let content = '';
  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, 'utf-8');
    if (content.includes(marker)) return false;
    if (!content.endsWith('\n')) content += '\n';
    content += '\n';
  } else {
    mkdirSync(join(home, '.claude'), { recursive: true });
  }

  content += `${marker}

Session continuity via hooks. Context auto-restored on session start from \`.claude/bookmarks/CONTEXT.md\`.
On stop, write a brief summary (task, progress, decisions, files) to \`.claude/bookmarks/CONTEXT.md\` when prompted.
File changes tracked automatically in \`trails/files.md\`. Commands: \`/bookmark:snapshot\`, \`/bookmark:status\`, \`/bookmark:list\`.
`;

  writeFileSync(claudeMdPath, content, 'utf-8');
  return true;
}

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
  const marker = '## Bookmark';
  const oldMarker = '## Bookmark — Context Snapshots';

  let content = '';
  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, 'utf-8');
    // Don't duplicate (check both old and new markers)
    if (content.includes(marker)) return false;
    if (!content.endsWith('\n')) content += '\n';
    content += '\n';
  } else {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
  }

  // Minimal injection — hooks handle behavior, this just documents commands
  content += `${marker}

Session continuity via hooks. Context auto-restored on session start from \`.claude/bookmarks/CONTEXT.md\`.
File changes tracked in \`trails/files.md\`. Commands: \`/bookmark:snapshot\`, \`/bookmark:status\`, \`/bookmark:list\`.
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
