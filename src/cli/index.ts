#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../snapshot/capture.js';
import { loadSnapshot, listSnapshots, readLatestMd, getSnapshotCount, ensureStorageDirs } from '../snapshot/storage.js';
import { compressToMarkdown } from '../snapshot/compress.js';
import { restoreContext } from '../restore/index.js';
import { loadState, saveState } from '../threshold/state.js';
import { checkTimeInterval } from '../threshold/time-based.js';
import { shouldSnapshotByThreshold } from '../threshold/adaptive.js';
import { quickEstimate } from '../transcript/estimator.js';
import { loadConfig, getStoragePath, writeConfig } from '../config.js';
import { configureHooks } from '../setup/configure-hooks.js';
import type { HookInput, SnapshotTrigger } from '../types.js';

const program = new Command();

program
  .name('bookmark')
  .description('Context snapshots for Claude Code — session continuity across compactions and terminals')
  .version('0.1.0');

// ─── Hook Commands (invoked by hooks, not users) ───

program
  .command('snapshot')
  .description('Capture a context snapshot')
  .option('--trigger <type>', 'Trigger type: pre_compact|time_interval|manual|session_end', 'manual')
  .option('--smart', 'Use Claude Haiku for enhanced extraction')
  .option('--transcript <path>', 'Path to transcript JSONL')
  .option('--session-id <id>', 'Session ID')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      let transcriptPath = opts.transcript ?? hookInput?.transcript_path;
      const sessionId = opts.sessionId ?? hookInput?.session_id;

      if (!transcriptPath) {
        // Try to discover transcript from ~/.claude/projects/
        transcriptPath = discoverTranscriptPath(cwd);
        if (!transcriptPath) {
          console.error('No transcript found. This command is typically called by hooks.');
          process.exit(1);
        }
      }

      const snapshot = await captureSnapshot({
        trigger: opts.trigger as SnapshotTrigger,
        transcriptPath,
        cwd,
        sessionId,
        smart: opts.smart,
      });

      console.log(`Snapshot captured: ${snapshot.snapshot_id}`);
      console.log(`  Trigger: ${snapshot.trigger}`);
      console.log(`  Decisions: ${snapshot.decisions.length}`);
      console.log(`  Files changed: ${snapshot.files_changed.length}`);
      console.log(`  Open items: ${snapshot.open_items.length}`);
      console.log(`  Context remaining: ${Math.round(snapshot.context_remaining_pct * 100)}%`);
    } catch (err) {
      console.error('Snapshot failed:', (err as Error).message);
      process.exit(1);
    }
  });

program
  .command('restore')
  .description('Generate restoration context (for SessionStart hook)')
  .option('--session-source <source>', 'Source: startup|resume|compact|clear')
  .option('--format <format>', 'Output: system_message|json|markdown', 'system_message')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      const source = opts.sessionSource ?? hookInput?.source ?? 'startup';

      const result = restoreContext({
        source,
        sessionId: hookInput?.session_id,
        cwd,
        format: opts.format,
      });

      // Output plain text for SessionStart hook — Claude sees stdout directly
      if (result.systemMessage) {
        console.log(result.systemMessage);
      }
    } catch {
      // Silent failure — don't break session start
    }
  });

program
  .command('check')
  .description('Check time/threshold intervals (for UserPromptSubmit hook)')
  .option('--transcript <path>', 'Path to transcript JSONL')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      const transcriptPath = opts.transcript ?? hookInput?.transcript_path;
      const config = loadConfig(cwd);
      const storagePath = getStoragePath(cwd, config);
      const state = loadState(storagePath);

      let shouldCapture = false;
      let reason = '';

      // Check time interval
      const timeCheck = checkTimeInterval(state);
      if (timeCheck.shouldSnapshot) {
        shouldCapture = true;
        reason = timeCheck.reason ?? 'time interval';
      }

      // Check adaptive threshold
      if (!shouldCapture && transcriptPath) {
        const { remainingPct } = quickEstimate(
          transcriptPath,
          config.contextLimitTokens,
          config.charsPerToken
        );
        if (shouldSnapshotByThreshold(remainingPct, state.compaction_count, config)) {
          shouldCapture = true;
          reason = `context at ${Math.round(remainingPct * 100)}% remaining (threshold: ${Math.round(state.current_threshold * 100)}%)`;
        }
      }

      if (shouldCapture && transcriptPath) {
        const snapshot = await captureSnapshot({
          trigger: 'time_interval',
          transcriptPath,
          cwd,
          sessionId: hookInput?.session_id,
        });
        if (config.verboseLogging) {
          console.error(`bookmark: auto-snapshot ${snapshot.snapshot_id} (${reason})`);
        }
      }

      // Update event time regardless
      saveState(storagePath, { ...state, last_event_time: Date.now() });
    } catch {
      // Silent — never break user prompt flow
    }
  });

// ─── User-Facing Commands ───

program
  .command('status')
  .description('Show snapshot inventory and stats')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);
    const state = loadState(storagePath);
    const count = getSnapshotCount(storagePath);
    const entries = listSnapshots(storagePath, 5);

    console.log('');
    console.log('Bookmark Status');
    console.log('═══════════════');
    console.log(`  Snapshots:          ${count}`);
    console.log(`  Compaction cycles:  ${state.compaction_count}`);
    console.log(`  Current threshold:  ${Math.round(state.current_threshold * 100)}% remaining`);
    console.log(`  Snapshot interval:  ${state.snapshot_interval_minutes} minutes`);

    if (state.last_snapshot_time > 0) {
      const ago = Math.round((Date.now() - state.last_snapshot_time) / 60_000);
      console.log(`  Last snapshot:      ${ago} minutes ago`);
    } else {
      console.log(`  Last snapshot:      never`);
    }

    if (entries.length > 0) {
      console.log('');
      console.log('Recent Snapshots:');
      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleString();
        const pct = Math.round(entry.context_remaining_pct * 100);
        console.log(`  ${entry.id}  ${entry.trigger.padEnd(14)}  ${pct}% ctx  ${date}`);
      }
    }

    console.log('');
  });

program
  .command('list')
  .description('List available snapshots')
  .option('--limit <n>', 'Max snapshots to show', '10')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);
    const entries = listSnapshots(storagePath, parseInt(opts.limit, 10));

    if (entries.length === 0) {
      console.log('No snapshots found. Run `/bookmark:snapshot` to create one.');
      return;
    }

    console.log('');
    console.log('ID                    Trigger          Ctx%   Decisions  Files  Open Items  Time');
    console.log('────────────────────  ───────────────  ─────  ─────────  ─────  ──────────  ────────────────────');
    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleString();
      const pct = `${Math.round(entry.context_remaining_pct * 100)}%`.padStart(4);
      console.log(
        `${entry.id}  ${entry.trigger.padEnd(15)}  ${pct}   ${String(entry.decisions_count).padStart(9)}  ${String(entry.files_changed_count).padStart(5)}  ${String(entry.open_items_count).padStart(10)}  ${date}`
      );
    }
    console.log('');
  });

program
  .command('show [snapshot_id]')
  .description('Show full snapshot detail')
  .option('--latest', 'Show the most recent snapshot')
  .option('--cwd <path>', 'Working directory')
  .action((snapshotId, opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);

    if (opts.latest || !snapshotId) {
      const md = readLatestMd(storagePath);
      if (md) {
        console.log(md);
      } else {
        console.log('No snapshots found.');
      }
      return;
    }

    const snapshot = loadSnapshot(storagePath, snapshotId);
    if (!snapshot) {
      console.log(`Snapshot not found: ${snapshotId}`);
      return;
    }

    console.log(compressToMarkdown(snapshot));
  });

program
  .command('config')
  .description('Show or set configuration')
  .option('--interval <minutes>', 'Set time-based interval')
  .option('--smart-default', 'Enable LLM-enhanced extraction by default')
  .option('--no-smart-default', 'Disable LLM-enhanced extraction')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);

    if (opts.interval) {
      const state = loadState(storagePath);
      state.snapshot_interval_minutes = parseInt(opts.interval, 10);
      saveState(storagePath, state);
      console.log(`Snapshot interval set to ${opts.interval} minutes`);
      return;
    }

    console.log('');
    console.log('Bookmark Configuration');
    console.log('══════════════════════');
    console.log(`  Storage path:       ${config.storagePath}`);
    console.log(`  Interval:           ${config.intervalMinutes} minutes`);
    console.log(`  Thresholds:         ${config.thresholds.map(t => `${Math.round(t * 100)}%`).join(', ')}`);
    console.log(`  Context limit:      ${config.contextLimitTokens.toLocaleString()} tokens`);
    console.log(`  Smart default:      ${config.smartDefault}`);
    console.log(`  Max snapshots:      ${config.maxActiveSnapshots}`);
    console.log(`  Archive after:      ${config.archiveAfterDays} days`);
    console.log('');
    console.log('Environment overrides:');
    console.log('  BOOKMARK_INTERVAL, BOOKMARK_THRESHOLD, BOOKMARK_STORAGE_PATH');
    console.log('  BOOKMARK_CONTEXT_LIMIT, BOOKMARK_SMART, ANTHROPIC_API_KEY');
    console.log('');
  });

program
  .command('init')
  .description('Initialize bookmark in current project (alias for setup --defaults)')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const cwd = opts.cwd ?? process.cwd();
    runSetup(cwd, true);
  });

program
  .command('setup')
  .description('Interactive setup — configure interval, smart mode, hooks')
  .option('--defaults', 'Use defaults without prompting')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const useDefaults = opts.defaults || !process.stdin.isTTY;
    await runSetup(cwd, useDefaults);
  });

program
  .command('uninstall')
  .description('Remove bookmark from project')
  .option('--remove-data', 'Also remove snapshot data')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    console.log('To uninstall bookmark:');
    console.log('  1. Remove the plugin: claude plugin remove bookmark');
    console.log('  2. npm uninstall -g @tyroneross/bookmark');
    if (opts.removeData) {
      const cwd = opts.cwd ?? process.cwd();
      const config = loadConfig(cwd);
      console.log(`  3. rm -rf ${join(cwd, config.storagePath)}`);
    }
  });

// ─── Helpers ───

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Discover the most recent transcript file for the given working directory.
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-path>/*.jsonl
 */
function discoverTranscriptPath(cwd: string): string | null {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return null;

  try {
    const projectDirs = readdirSync(claudeProjectsDir);

    // Claude Code encodes paths by replacing / with -
    // e.g., /Users/tyroneross/myproject → -Users-tyroneross-myproject
    const encodedCwd = cwd.replace(/\//g, '-');
    const matchingDir = projectDirs.find(d =>
      d === encodedCwd || d.includes(encodedCwd) || encodedCwd.includes(d)
    );

    if (!matchingDir) return null;

    const transcriptDir = join(claudeProjectsDir, matchingDir);
    const stat = statSync(transcriptDir);
    if (!stat.isDirectory()) return null;

    // Find the most recent .jsonl file by modification time
    const files = readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        name: f,
        mtime: statSync(join(transcriptDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files[0] ? join(transcriptDir, files[0].name) : null;
  } catch {
    return null;
  }
}

/**
 * Ask a question on the terminal and return the answer.
 */
function askQuestion(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive (or default) setup for bookmark in a project.
 */
async function runSetup(cwd: string, useDefaults: boolean): Promise<void> {
  let intervalMinutes = 20;
  let smartDefault = false;

  console.log('');
  console.log(`${BOLD}Bookmark — Context Snapshot Setup${RESET}`);
  console.log('═════════════════════════════════');
  console.log('');

  if (!useDefaults) {
    // Prompt for interval
    console.log('Snapshot interval?');
    console.log('  1) 10 minutes (frequent)');
    console.log('  2) 15 minutes');
    console.log(`  3) 20 minutes ${DIM}(recommended)${RESET}`);
    console.log('  4) 30 minutes (conservative)');
    console.log('');
    const intervalAnswer = await askQuestion(`${DIM}> ${RESET}`);
    const intervalMap: Record<string, number> = { '1': 10, '2': 15, '3': 20, '4': 30 };
    intervalMinutes = intervalMap[intervalAnswer] ?? 20;
    console.log('');

    // Prompt for smart mode
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    console.log('Smart mode (uses Claude Haiku for better extraction, ~$0.001/snapshot)?');
    if (hasApiKey) {
      console.log(`  ${GREEN}ANTHROPIC_API_KEY detected.${RESET}`);
    } else {
      console.log(`  ${DIM}No ANTHROPIC_API_KEY found — smart mode requires it.${RESET}`);
    }
    console.log('  1) Enable smart mode');
    console.log(`  2) Pattern-matching only ${DIM}(recommended)${RESET}`);
    console.log('');
    const smartAnswer = await askQuestion(`${DIM}> ${RESET}`);
    smartDefault = smartAnswer === '1';
    console.log('');
  }

  // 1. Create storage directories
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  ensureStorageDirs(storagePath);

  const steps: string[] = [];
  steps.push('Created .claude/bookmarks/');

  // 2. Configure hooks
  try {
    configureHooks(cwd);
    steps.push('Configured 4 hooks (PreCompact, SessionStart, UserPromptSubmit, Stop)');
  } catch { /* skip */ }

  // 3. Write config
  writeConfig(cwd, { intervalMinutes, smartDefault });
  steps.push('Saved config to .claude/bookmarks/config.json');

  // 4. Initialize state
  const state = loadState(storagePath);
  state.snapshot_interval_minutes = intervalMinutes;
  saveState(storagePath, state);

  // Print summary
  console.log('Setup complete:');
  for (const step of steps) {
    console.log(`  ${GREEN}+${RESET} ${step}`);
  }

  console.log('');
  console.log('Defaults:');
  console.log(`  Interval:     ${intervalMinutes} minutes`);
  console.log(`  Thresholds:   20% → 30% → 40% → 50% (adaptive)`);
  console.log(`  Smart mode:   ${smartDefault ? 'on' : 'off'}`);
  console.log('');
  console.log(`${GREEN}Ready.${RESET} Start a Claude Code session — snapshots will be captured automatically.`);
  console.log('');
}

/**
 * Read hook input from stdin (JSON piped by Claude Code hooks).
 */
async function readHookInput(): Promise<HookInput | null> {
  // Check if stdin has data (non-TTY means piped)
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = '';
    const timeout = setTimeout(() => resolve(null), 1000);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data) as HookInput);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
    process.stdin.resume();
  });
}

program.parse();
