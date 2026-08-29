#!/usr/bin/env node

import { Command } from 'commander';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { captureSnapshot } from '../snapshot/capture.js';
import { loadSnapshot, listSnapshots, readLatestMd, getSnapshotCount, ensureStorageDirs } from '../snapshot/storage.js';
import { compressToMarkdown } from '../snapshot/compress.js';
import { readContextMd } from '../trails/reader.js';
import { restoreContext } from '../restore/index.js';
import { loadState, saveState } from '../threshold/state.js';
import { checkTimeInterval } from '../threshold/time-based.js';
import {
  handledThresholdsForUsage,
  newlyCrossedThresholds,
  readLatestContextUsage,
} from '../threshold/token-usage.js';
import { buildHandoffPrompt } from '../context/handoff-prompt.js';
import { isContextMdFresh } from '../context/freshness.js';
import { loadConfig, getStoragePath, writeConfig } from '../config.js';
import { configureHooks } from '../setup/configure-hooks.js';
import { ensureProjectBootstrapped, setupProject } from '../setup/auto-setup.js';
import { findById, pruneStale, getLastProject, loadRegistry } from '../registry.js';
import { parseIdentity } from '../trails/identity.js';
import type { HookInput, SnapshotTrigger } from '../types.js';

const program = new Command();

program
  .name('bookmark')
  .description('Context snapshots for Claude Code — session continuity across compactions and terminals')
  .version('0.3.2');

// ─── Hook Commands (invoked by hooks, not users) ───

program
  .command('snapshot')
  .description('Capture a context snapshot')
  .option('--trigger <type>', 'Trigger type: pre_compact|token_threshold|time_interval|manual|session_end', 'manual')
  .option('--transcript <path>', 'Path to transcript JSONL')
  .option('--session-id <id>', 'Session ID')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      ensureProjectBootstrapped(cwd);
      let transcriptPath = opts.transcript ?? hookInput?.transcript_path;
      const sessionId = opts.sessionId ?? hookInput?.session_id;

      if (!transcriptPath) {
        transcriptPath = discoverTranscriptPath(cwd);
        if (!transcriptPath) {
          if (opts.trigger === 'manual') {
            console.log('No transcript found. Using existing Bookmark trails for this manual checkpoint.');
          } else {
            console.error('No transcript found. This command is typically called by hooks.');
            process.exit(1);
          }
        }
      }

      const snapshot = await captureSnapshot({
        trigger: opts.trigger as SnapshotTrigger,
        transcriptPath,
        cwd,
        sessionId,
      });

      console.log(`Snapshot captured: ${snapshot.snapshot_id}`);
      console.log(`  Trigger: ${snapshot.trigger}`);
      console.log(`  Files changed: ${snapshot.files_changed.length}`);
      console.log(`  Tools tracked: ${Object.keys(snapshot.tools_summary).length}`);
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
      ensureProjectBootstrapped(cwd);
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
  .description('Check the time interval (async UserPromptSubmit hook)')
  .option('--transcript <path>', 'Path to transcript JSONL')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      ensureProjectBootstrapped(cwd);
      const transcriptPath = opts.transcript ?? hookInput?.transcript_path;
      const config = loadConfig(cwd);
      const storagePath = getStoragePath(cwd, config);
      const state = loadState(storagePath);

      let shouldCapture = false;
      let reason = '';

      // Legacy interval-only command. Installed hooks use context-check so
      // interval capture and measured token usage share one state writer.
      const timeCheck = checkTimeInterval(state);
      if (timeCheck.shouldSnapshot) {
        shouldCapture = true;
        reason = timeCheck.reason ?? 'time interval';
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

program
  .command('context-check')
  .description('Capture and notify when context usage crosses a token threshold')
  .option('--transcript <path>', 'Path to transcript JSONL')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.cwd();
      ensureProjectBootstrapped(cwd);
      const transcriptPath = opts.transcript ?? hookInput?.transcript_path;
      if (!transcriptPath) {
        console.log(JSON.stringify({}));
        return;
      }

      const config = loadConfig(cwd);
      const storagePath = getStoragePath(cwd, config);
      const state = loadState(storagePath);
      const timeCheck = checkTimeInterval(state);
      const observation = readLatestContextUsage(
        transcriptPath,
        config.contextLimitTokens,
        hookInput?.prompt
      );

      if (!observation) {
        if (timeCheck.shouldSnapshot) {
          await captureSnapshot({
            trigger: 'time_interval',
            transcriptPath,
            cwd,
            sessionId: hookInput?.session_id,
          });
        }
        console.log(JSON.stringify({}));
        return;
      }

      if (observation.status === 'unknown_context_limit') {
        const shouldNotify = state.unknown_context_limit_notified_model !== observation.model;
        const observedState = {
          ...state,
          last_event_time: Date.now(),
          latest_model: observation.model,
          latest_context_tokens: observation.usedTokens,
          latest_context_limit_tokens: undefined,
          latest_context_used_pct: undefined,
          latest_context_observed_at: Date.now(),
          unknown_context_limit_notified_model: observation.model,
        };

        if (timeCheck.shouldSnapshot) {
          await captureSnapshot({
            trigger: 'time_interval',
            transcriptPath,
            cwd,
            sessionId: hookInput?.session_id,
          });
          const refreshedState = loadState(storagePath);
          saveState(storagePath, {
            ...refreshedState,
            last_event_time: observedState.last_event_time,
            latest_model: observedState.latest_model,
            latest_context_tokens: observedState.latest_context_tokens,
            latest_context_limit_tokens: observedState.latest_context_limit_tokens,
            latest_context_used_pct: observedState.latest_context_used_pct,
            latest_context_observed_at: observedState.latest_context_observed_at,
            unknown_context_limit_notified_model: observedState.unknown_context_limit_notified_model,
          });
        } else {
          saveState(storagePath, observedState);
        }

        if (shouldNotify) {
          console.log(JSON.stringify({
            systemMessage:
              `Bookmark detected ${observation.model}, but its context limit is not verified. ` +
              'Token-threshold capture is paused for this model. ' +
              'Set the verified limit with `bookmark config --context-limit <tokens>`. ' +
              `Manual snapshots and ${state.snapshot_interval_minutes}-minute periodic snapshots remain active.`,
          }));
        } else {
          console.log(JSON.stringify({}));
        }
        return;
      }

      const usage = observation;

      const observedState = {
        ...state,
        last_event_time: Date.now(),
        latest_model: usage.model,
        latest_context_tokens: usage.usedTokens,
        latest_context_limit_tokens: usage.contextLimitTokens,
        latest_context_used_pct: usage.usedFraction,
        latest_context_observed_at: Date.now(),
        unknown_context_limit_notified_model: undefined,
      };
      const handledThresholds = handledThresholdsForUsage(
        usage.usedFraction,
        config.tokenThresholds,
        state.token_thresholds_triggered
      );
      observedState.token_thresholds_triggered = handledThresholds;
      const crossed = newlyCrossedThresholds(
        usage.usedFraction,
        config.tokenThresholds,
        handledThresholds
      );

      if (crossed.length === 0) {
        if (timeCheck.shouldSnapshot) {
          await captureSnapshot({
            trigger: 'time_interval',
            transcriptPath,
            cwd,
            sessionId: hookInput?.session_id,
          });
          const refreshedState = loadState(storagePath);
          saveState(storagePath, {
            ...refreshedState,
            last_event_time: observedState.last_event_time,
            latest_model: observedState.latest_model,
            latest_context_tokens: observedState.latest_context_tokens,
            latest_context_limit_tokens: observedState.latest_context_limit_tokens,
            latest_context_used_pct: observedState.latest_context_used_pct,
            latest_context_observed_at: observedState.latest_context_observed_at,
            unknown_context_limit_notified_model: observedState.unknown_context_limit_notified_model,
            token_thresholds_triggered: observedState.token_thresholds_triggered,
          });
        } else {
          saveState(storagePath, observedState);
        }
        console.log(JSON.stringify({}));
        return;
      }

      const snapshot = await captureSnapshot({
        trigger: 'token_threshold',
        transcriptPath,
        cwd,
        sessionId: hookInput?.session_id,
        contextUsage: usage,
      });

      const refreshedState = loadState(storagePath);
      saveState(storagePath, {
        ...refreshedState,
        latest_model: usage.model,
        latest_context_tokens: usage.usedTokens,
        latest_context_limit_tokens: usage.contextLimitTokens,
        latest_context_used_pct: usage.usedFraction,
        latest_context_observed_at: Date.now(),
        unknown_context_limit_notified_model: undefined,
        token_thresholds_triggered: [
          ...new Set([...(handledThresholds ?? []), ...crossed]),
        ],
      });

      const threshold = crossed[crossed.length - 1];
      const thresholdPct = Math.round(threshold * 100);
      const usedPct = Math.round(usage.usedFraction * 100);
      const reason = `Context usage crossed ${thresholdPct}% (${usedPct}% observed; snapshot ${snapshot.snapshot_id}).`;
      const handoffPrompt = buildHandoffPrompt({ cwd, reason });

      console.log(JSON.stringify({
        systemMessage:
          `Bookmark captured ${snapshot.snapshot_id} at ${usedPct}% of the ${usage.model} context window. ` +
          'Bookmark asked Claude to update the handoff. Start a new session after this response to restore it.',
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext:
            `${handoffPrompt}\nAfter successfully writing it, tell the user to start a new Claude session with /clear or by exiting and reopening Claude Code.`,
        },
      }));
    } catch {
      // Context protection must never block the user's prompt.
      console.log(JSON.stringify({}));
    }
  });

program
  .command('stop')
  .description('Stop hook — capture files, conditionally block for bookmark.context.md (for Stop hook)')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      ensureProjectBootstrapped(cwd);

      // Always capture file tracking snapshot
      const transcriptPath = hookInput?.transcript_path ?? discoverTranscriptPath(cwd);
      if (transcriptPath) {
        try {
          await captureSnapshot({
            trigger: 'session_end',
            transcriptPath,
            cwd,
            sessionId: hookInput?.session_id ?? process.env.CLAUDE_SESSION_ID,
          });
        } catch { /* file tracking is best-effort */ }
      }

      // Update home-scope pointer to track the most recently active project
      updateHomePointer(cwd);

      const config = loadConfig(cwd);
      const storagePath = getStoragePath(cwd, config);
      const contextPath = join(storagePath, 'bookmark.context.md');
      const markerPath = join(storagePath, '.stop-requested');

      // Quality gate: check if bookmark.context.md has real content
      if (isContextMdFresh(contextPath, markerPath)) {
        console.log(JSON.stringify({ decision: 'approve' }));
        return;
      }

      // Check .stop-requested marker — max 1 block to prevent loops
      if (existsSync(markerPath)) {
        // Already blocked once — approve to prevent infinite loop
        console.log(JSON.stringify({ decision: 'approve' }));
        return;
      }

      // First time — write JSON marker, track the block, and block
      const marker = JSON.stringify({
        timestamp: Date.now(),
        session_id: hookInput?.session_id ?? process.env.CLAUDE_SESSION_ID ?? 'unknown',
      });
      writeFileSync(markerPath, marker, 'utf-8');
      try {
        const st = loadState(storagePath);
        st.quality_blocks = (st.quality_blocks ?? 0) + 1;
        saveState(storagePath, st);
      } catch { /* tracking is best-effort */ }
      const handoffPrompt = buildHandoffPrompt({
        cwd,
        reason: 'The session is stopping and needs a durable handoff.',
      });
      console.log(JSON.stringify({
        decision: 'block',
        reason: handoffPrompt,
        systemMessage: 'Bookmark needs Claude to refresh the session handoff before stopping.',
      }));
    } catch (err) {
      // Log error for debugging, then approve to never block stop
      try {
        const config = loadConfig(opts.cwd ?? process.cwd());
        const storagePath = getStoragePath(opts.cwd ?? process.cwd(), config);
        const errLog = join(storagePath, '.errors.log');
        appendFileSync(errLog, `[${new Date().toISOString()}] stop: ${(err as Error).message}\n`);
      } catch { /* truly silent */ }
      console.log(JSON.stringify({ decision: 'approve' }));
    }
  });

program
  .command('precompact')
  .description('PreCompact hook — capture a mechanical checkpoint')
  .option('--cwd <path>', 'Working directory')
  .action(async (opts) => {
    try {
      const hookInput = await readHookInput();
      const cwd = opts.cwd ?? hookInput?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      ensureProjectBootstrapped(cwd);

      // Always capture file tracking snapshot
      const transcriptPath = hookInput?.transcript_path ?? discoverTranscriptPath(cwd);
      if (transcriptPath) {
        try {
          await captureSnapshot({
            trigger: 'pre_compact',
            transcriptPath,
            cwd,
            sessionId: hookInput?.session_id ?? process.env.CLAUDE_SESSION_ID,
          });
        } catch { /* file tracking is best-effort */ }
      }

      // Claude Code discards PreCompact systemMessage output. The synchronous
      // 75% UserPromptSubmit hook is the semantic-handoff activation path.
      console.log(JSON.stringify({}));
    } catch {
      // Never block compaction
      console.log(JSON.stringify({}));
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
    console.log(`  Snapshot interval:  ${state.snapshot_interval_minutes} minutes`);
    console.log(`  New-session alert:  ${config.tokenThresholds.map(t => `${Math.round(t * 100)}%`).join(', ')} used when limit is known`);

    if (state.latest_context_used_pct !== undefined) {
      const usedPct = Math.round(state.latest_context_used_pct * 100);
      const usedTokens = state.latest_context_tokens ?? 0;
      const limitTokens = state.latest_context_limit_tokens ?? 0;
      console.log(`  Context usage:      ${usedPct}% (${formatTokenCount(usedTokens)} / ${formatTokenCount(limitTokens)})`);
      if (state.latest_model) console.log(`  Active model:       ${state.latest_model}`);
    } else if (state.latest_model && state.latest_context_tokens !== undefined) {
      console.log(`  Context usage:      ${formatTokenCount(state.latest_context_tokens)} tokens; limit unknown`);
      console.log(`  Active model:       ${state.latest_model}`);
      console.log('  Required action:    bookmark config --context-limit <tokens>');
    }

    if (state.last_snapshot_time > 0) {
      const ago = Math.round((Date.now() - state.last_snapshot_time) / 60_000);
      console.log(`  Last snapshot:      ${ago} minutes ago`);
    } else {
      console.log(`  Last snapshot:      never`);
    }

    // Usage counters — only show when there's data
    const restores = state.restores_performed ?? 0;
    const tokensInjected = state.tokens_injected ?? 0;
    const blocks = state.quality_blocks ?? 0;
    const caught = state.boilerplate_caught ?? 0;

    if (restores > 0 || blocks > 0) {
      console.log('');
      console.log('Usage:');
      if (restores > 0) {
        console.log(`  Sessions restored:  ${restores}`);
        console.log(`  Tokens injected:    ~${tokensInjected}`);
      }
      if (blocks > 0) {
        console.log(`  Quality blocks:     ${blocks} (asked Claude to write bookmark.context.md)`);
      }
      if (caught > 0) {
        console.log(`  Boilerplate caught: ${caught} (skipped stale restore)`);
      }
    }

    if (entries.length > 0) {
      console.log('');
      console.log('Recent Snapshots:');
      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleString();
        console.log(`  ${entry.id}  ${entry.trigger.padEnd(14)}  ${date}`);
      }
    }

    console.log('');
  });

program
  .command('list')
  .description('List available snapshots')
  .option('--limit <n>', 'Max snapshots to show', '10')
  .option('--all', 'List snapshots across all projects (from global registry)')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const limit = parseInt(opts.limit, 10);

    if (opts.all) {
      const registry = pruneStale();
      const entries = registry.snapshots.slice(0, limit);
      if (entries.length === 0) {
        console.log('No snapshots in global registry yet.');
        return;
      }
      console.log('');
      console.log('ID                    Project                   Trigger          Files  Time');
      console.log('────────────────────  ────────────────────────  ───────────────  ─────  ────────────────────');
      for (const entry of entries) {
        const date = new Date(entry.timestamp).toLocaleString();
        const proj = entry.project_name.length > 24 ? entry.project_name.slice(0, 23) + '…' : entry.project_name;
        console.log(
          `${entry.id}  ${proj.padEnd(24)}  ${entry.trigger.padEnd(15)}  ${String(entry.files_changed_count).padStart(5)}  ${date}`
        );
      }
      console.log('');
      return;
    }

    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);
    const entries = listSnapshots(storagePath, limit);

    if (entries.length === 0) {
      const last = getLastProject();
      if (last && last.path !== cwd) {
        console.log('No snapshots in this project.');
        console.log(`Last active project: ${last.name} (${last.path})`);
        console.log('Run `bookmark list --all` for the cross-project view.');
      } else {
        console.log('No snapshots found. Run `/bookmark:snapshot` to create one.');
      }
      return;
    }

    console.log('');
    console.log('ID                    Trigger          Files  Time');
    console.log('────────────────────  ───────────────  ─────  ────────────────────');
    for (const entry of entries) {
      const date = new Date(entry.timestamp).toLocaleString();
      console.log(
        `${entry.id}  ${entry.trigger.padEnd(15)}  ${String(entry.files_changed_count).padStart(5)}  ${date}`
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
      const contextMd = readContextMd(storagePath);
      const latestMd = readLatestMd(storagePath);

      if (!contextMd && !latestMd) {
        console.log('No snapshots found.');
        return;
      }

      if (contextMd) {
        console.log(contextMd);
      }

      if (contextMd && latestMd) {
        console.log('');
        console.log('─── File Trail ───');
        console.log('');
      }

      if (latestMd) {
        console.log(latestMd);
      }
      return;
    }

    let snapshot = loadSnapshot(storagePath, snapshotId);

    // Registry fallback: not in current CWD, maybe it belongs to another project
    if (!snapshot) {
      const entry = findById(snapshotId);
      if (entry) {
        const otherStorage = join(entry.project_path, config.storagePath);
        snapshot = loadSnapshot(otherStorage, snapshotId);
        if (snapshot) {
          console.log(`[bookmark: resolved via registry → ${entry.project_name} (${entry.project_path})]`);
          console.log('');
        }
      }
    }

    if (!snapshot) {
      console.log(`Snapshot not found: ${snapshotId}`);
      return;
    }

    console.log(compressToMarkdown(snapshot));
  });

program
  .command('clear')
  .description('Write a home-scope pointer to the most-recent project and print its context')
  .option('--project <path>', 'Point at a specific project root instead of the last-active one')
  .option('--no-print', 'Skip printing the canonical context to stdout')
  .option('--no-pointer', 'Skip writing ~/.bookmark/bookmark.context.md pointer')
  .action((opts) => {
    // Resolve target project:
    // 1. explicit --project wins
    // 2. else registry.last_project, but skip if it points at $HOME (stale/bad state)
    // 3. else most-recent snapshot whose project_path !== $HOME and has a bookmark.context.md
    const home = homedir();

    let targetPath: string | null = null;
    let targetName: string | null = null;

    if (opts.project) {
      targetPath = opts.project;
      targetName = basename(opts.project);
    } else {
      const last = getLastProject();
      if (last && last.path !== home) {
        targetPath = last.path;
        targetName = last.name;
      } else {
        // Fall back: scan registry snapshots for the most recent real project.
        const registry = loadRegistry();
        for (const entry of registry.snapshots) {
          if (entry.project_path === home) continue;
          const candidate = join(entry.project_path, '.bookmark', 'bookmark.context.md');
          if (existsSync(candidate)) {
            targetPath = entry.project_path;
            targetName = entry.project_name;
            break;
          }
        }
      }
    }

    if (!targetPath || !targetName) {
      console.error('No last-active project found in the registry. Run `bookmark list --all`.');
      console.error('Or pass --project <path> to point at a specific project.');
      process.exit(1);
    }

    let canonicalPath = join(targetPath, '.bookmark', 'bookmark.context.md');
    if (!existsSync(canonicalPath)) {
      console.error(`No bookmark.context.md at ${canonicalPath}.`);
      console.error('That project has no session summary to restore from.');
      process.exit(1);
    }

    let canonicalContent = readFileSync(canonicalPath, 'utf-8');

    // If target is itself a home-scope pointer, follow it to the real canonical file.
    const { identity } = parseIdentity(canonicalContent);
    if (identity?.scope === 'home' && identity.points_to_canonical && existsSync(identity.points_to_canonical)) {
      canonicalPath = identity.points_to_canonical;
      canonicalContent = readFileSync(canonicalPath, 'utf-8');
      if (identity.points_to_project) targetName = identity.points_to_project;
      const marker = '/.bookmark/';
      const idx = canonicalPath.lastIndexOf(marker);
      if (idx > 0) targetPath = canonicalPath.slice(0, idx);
    }

    if (opts.pointer !== false) {
      const homeDir = join(homedir(), '.bookmark');
      if (!existsSync(homeDir)) mkdirSync(homeDir, { recursive: true });

      const pointerBody = [
        `# Bookmark Pointer — ${targetName}`,
        '',
        '<!-- BOOKMARK_IDENTITY',
        'scope: home',
        'project: POINTER_ONLY',
        `points_to_project: ${targetName}`,
        `points_to_canonical: ${canonicalPath}`,
        `written: ${new Date().toISOString().slice(0, 10)}`,
        'written_by: bookmark-clear',
        '-->',
        '',
        `Redirects SessionStart to: ${targetName}`,
        `Canonical file: ${canonicalPath}`,
        '',
        '*This file was written by `bookmark clear`. The next Claude Code session',
        'started from this directory (or any directory without its own .bookmark/)',
        'will follow the pointer above and restore the canonical context.*',
      ].join('\n');

      writeFileSync(join(homeDir, 'bookmark.context.md'), pointerBody, 'utf-8');
      console.error(`[bookmark] Home pointer → ${targetName} (${canonicalPath})`);
    }

    if (opts.print !== false) {
      console.log(canonicalContent);
    }
  });

program
  .command('config')
  .description('Show or set configuration')
  .option('--interval <minutes>', 'Set time-based interval')
  .option('--token-threshold <fraction>', 'Set context-used threshold (0.75 or 75)')
  .option('--context-limit <tokens>', 'Override model context limit')
  .option('--cwd <path>', 'Working directory')
  .action((opts) => {
    const cwd = opts.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);

    if (opts.interval || opts.tokenThreshold || opts.contextLimit) {
      const preferences: Parameters<typeof writeConfig>[1] = {};

      if (opts.interval) {
        const interval = Number.parseInt(opts.interval, 10);
        if (!Number.isFinite(interval) || interval <= 0) {
          console.error('Interval must be a positive number of minutes.');
          process.exitCode = 1;
          return;
        }
        preferences.intervalMinutes = interval;
      }

      if (opts.tokenThreshold) {
        const threshold = normalizeThreshold(Number(opts.tokenThreshold));
        if (threshold === null) {
          console.error('Token threshold must be between 0 and 1, or between 1 and 100 percent.');
          process.exitCode = 1;
          return;
        }
        preferences.tokenThresholds = [threshold];
      }

      if (opts.contextLimit) {
        const limit = Number.parseInt(opts.contextLimit, 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error('Context limit must be a positive token count.');
          process.exitCode = 1;
          return;
        }
        preferences.contextLimitTokens = limit;
      }

      writeConfig(cwd, preferences);

      if (preferences.intervalMinutes !== undefined) {
        const state = loadState(storagePath);
        state.snapshot_interval_minutes = preferences.intervalMinutes;
        saveState(storagePath, state);
      }

      if (preferences.intervalMinutes !== undefined) {
        console.log(`Snapshot interval set to ${preferences.intervalMinutes} minutes`);
      }
      if (preferences.tokenThresholds) {
        console.log(`Token threshold set to ${Math.round(preferences.tokenThresholds[0] * 100)}% used`);
      }
      if (preferences.contextLimitTokens) {
        console.log(`Context limit set to ${preferences.contextLimitTokens} tokens`);
      }
      return;
    }

    console.log('');
    console.log('Bookmark Configuration');
    console.log('══════════════════════');
    console.log(`  Storage path:       ${config.storagePath}`);
    console.log(`  Interval:           ${config.intervalMinutes} minutes`);
    console.log(`  Token thresholds:   ${config.tokenThresholds.map(t => `${Math.round(t * 100)}% used`).join(', ')}`);
    console.log(`  Context limit:      ${config.contextLimitTokens ? formatTokenCount(config.contextLimitTokens) : 'model-aware'}`);
    console.log(`  Max snapshots:      ${config.maxActiveSnapshots}`);
    console.log(`  Archive after:      ${config.archiveAfterDays} days`);
    console.log('');
    console.log('Environment overrides:');
    console.log('  BOOKMARK_INTERVAL, BOOKMARK_TOKEN_THRESHOLD, BOOKMARK_CONTEXT_LIMIT');
    console.log('  BOOKMARK_STORAGE_PATH');
    console.log('  BOOKMARK_VERBOSE');
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

/**
 * Update the home-directory pointer at ~/.bookmark/bookmark.context.md to point
 * at the project that just ended a session.
 *
 * Only writes when:
 *   - cwd is NOT the home directory (no self-pointing)
 *   - the project's .bookmark/bookmark.context.md actually exists
 *
 * Wrapped in try/catch — never breaks the main stop flow.
 */
function updateHomePointer(cwd: string): void {
  try {
    const home = homedir();
    if (!home || cwd === home) return;

    const projectContextPath = join(cwd, '.bookmark', 'bookmark.context.md');
    if (!existsSync(projectContextPath)) return;

    // Derive a short project name from the directory basename
    const projectName = basename(cwd)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');

    const homeBookmarkDir = join(home, '.bookmark');
    if (!existsSync(homeBookmarkDir)) {
      mkdirSync(homeBookmarkDir, { recursive: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const pointerContent = [
      '# Active Work Pointer (home-scoped bookmark)',
      '',
      '<!-- BOOKMARK_IDENTITY',
      'scope: home',
      'project: POINTER_ONLY',
      `points_to_project: ${projectName}`,
      `points_to_repo: ${cwd}`,
      `points_to_canonical: ${projectContextPath}`,
      `written: ${today}`,
      'written_by: bookmark-plugin',
      '-->',
      '',
      '> **This is the HOME-directory pointer**, not a full session context.',
      `> It delegates to the repo-scope bookmark at \`${projectContextPath}\`.`,
      '',
    ].join('\n');

    writeFileSync(join(homeBookmarkDir, 'bookmark.context.md'), pointerContent, 'utf-8');
  } catch {
    // Never propagate — pointer update is best-effort
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function normalizeThreshold(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  return normalized > 0 && normalized < 1 ? normalized : null;
}

const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/**
 * Discover the most recent transcript file for the given working directory.
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-path>/*.jsonl
 *
 * Uses CLAUDE_SESSION_ID env var if available (set by Claude Code hooks),
 * otherwise falls back to finding the most recent JSONL by file size + recency.
 */
function discoverTranscriptPath(cwd: string): string | null {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return null;

  try {
    const projectDirs = readdirSync(claudeProjectsDir);

    // Claude Code encodes paths by replacing / with -
    // e.g., /Users/tyroneross/myproject → -Users-tyroneross-myproject
    const encodedCwd = cwd.replace(/\//g, '-');

    // Exact match only — fuzzy matching caused cross-project contamination
    // where e.g. FloDoro would match bookmark's transcript dir via startsWith
    const matchingDir = projectDirs.find(d => d === encodedCwd);
    if (!matchingDir) return null;

    const transcriptDir = join(claudeProjectsDir, matchingDir);
    const dirStat = statSync(transcriptDir);
    if (!dirStat.isDirectory()) return null;

    const sessionId = process.env.CLAUDE_SESSION_ID;

    // If we have a session ID, look for that specific file first
    if (sessionId) {
      const sessionFile = join(transcriptDir, `${sessionId}.jsonl`);
      if (existsSync(sessionFile)) return sessionFile;
    }

    // Fall back: find the most recent .jsonl file by modification time,
    // but skip tiny files (likely just file-history-snapshot entries)
    const files = readdirSync(transcriptDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const s = statSync(join(transcriptDir, f));
        return { name: f, mtime: s.mtimeMs, size: s.size };
      })
      // Prefer files >10KB (actual conversations, not just metadata)
      .sort((a, b) => {
        const aSubstantial = a.size > 10_000 ? 1 : 0;
        const bSubstantial = b.size > 10_000 ? 1 : 0;
        if (aSubstantial !== bSubstantial) return bSubstantial - aSubstantial;
        return b.mtime - a.mtime;
      });

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
  let intervalMinutes = 5;

  console.log('');
  console.log(`${BOLD}Bookmark — Context Snapshot Setup${RESET}`);
  console.log('═════════════════════════════════');
  console.log('');

  if (!useDefaults) {
    // Prompt for interval
    console.log('Snapshot interval?');
    console.log(`  1) 5 minutes ${DIM}(recommended)${RESET}`);
    console.log('  2) 10 minutes');
    console.log('  3) 15 minutes');
    console.log('  4) 20 minutes');
    console.log('  5) 30 minutes (conservative)');
    console.log('');
    const intervalAnswer = await askQuestion(`${DIM}> ${RESET}`);
    const intervalMap: Record<string, number> = { '1': 5, '2': 10, '3': 15, '4': 20, '5': 30 };
    intervalMinutes = intervalMap[intervalAnswer] ?? 5;
    console.log('');
  }

  // Run core setup (dirs, hooks, gitignore, CLAUDE.md)
  const steps = setupProject(cwd);

  // Write user preferences
  writeConfig(cwd, { intervalMinutes });
  steps.push('Saved config to .bookmark/config.json');

  // Initialize state with user preferences
  const sp = getStoragePath(cwd);
  const state = loadState(sp);
  state.snapshot_interval_minutes = intervalMinutes;
  saveState(sp, state);

  // Print summary
  console.log('Setup complete:');
  for (const step of steps) {
    console.log(`  ${GREEN}+${RESET} ${step}`);
  }

  console.log('');
  console.log('Defaults:');
  console.log(`  Interval:     ${intervalMinutes} minutes`);
  console.log('  New session:  suggest at 75% context used');
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
