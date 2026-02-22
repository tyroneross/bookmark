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

  // Handle global installs — no project context, but give helpful guidance
  if (process.env.npm_config_global === 'true') {
    console.log(`\n  ${GREEN}Bookmark${RESET} installed globally.`);
    console.log(`  Run ${CYAN}bookmark setup${RESET} in your project to configure.`);
    console.log(`  Or: ${CYAN}claude plugin add github.com/tyroneross/bookmark${RESET}\n`);
    return;
  }

  const projectRoot = findProjectRoot();

  // Verify we found a real project
  if (projectRoot === '/' || !existsSync(join(projectRoot, 'package.json'))) {
    return;
  }

  // Skip if this is our own package (development mode)
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    if (pkg.name === '@tyroneross/bookmark') return;
  } catch { /* ignore */ }

  console.log(`\n  ${GREEN}Bookmark${RESET} — Setting up context snapshots\n`);

  const steps: string[] = [];

  try {
    // 1. Ensure storage directories
    const bookmarkPath = join(projectRoot, '.claude', 'bookmarks');
    mkdirSync(join(bookmarkPath, 'snapshots'), { recursive: true });
    mkdirSync(join(bookmarkPath, 'archive'), { recursive: true });
    steps.push('Created .claude/bookmarks/ directories');

    // 2. Configure hooks in settings.json
    try {
      configureHooks(projectRoot);
      steps.push('Configured 4 hooks (PreCompact, SessionStart, UserPromptSubmit, Stop)');
    } catch { /* silently skip */ }

    // 3. Inject CLAUDE.md section
    try {
      const updated = injectClaudeMd(projectRoot);
      if (updated) {
        steps.push('Updated .claude/CLAUDE.md with bookmark docs');
      }
    } catch { /* silently skip */ }

    // Print what happened
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
    console.log(`  ${DIM}Run${RESET} ${CYAN}bookmark setup${RESET} ${DIM}for interactive configuration${RESET}`);
    console.log();

  } catch (error) {
    // Don't fail npm install
    console.warn(`  Setup skipped: ${(error as Error).message}\n`);
  }
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

autoSetup();
