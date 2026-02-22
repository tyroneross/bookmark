import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureHooks } from './configure-hooks.js';

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

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
- Context restored automatically on session start
- Adaptive thresholds increase snapshot frequency with compaction count
- Time-based snapshots every 20 minutes (configurable)

**Commands:**
- \`/bookmark:snapshot\` — Manual snapshot
- \`/bookmark:restore\` — Restore from a snapshot
- \`/bookmark:status\` — Show snapshot stats
- \`/bookmark:list\` — List all snapshots

The system operates with zero context window tax — all processing runs externally.
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
