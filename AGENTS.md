# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI) working with this codebase.

## What This Is

`@tyroneross/bookmark` is a session context continuity system for Claude Code. It auto-saves context before compactions and terminal closures, then restores it when a new session starts. It ships as both an npm package (CLI + library) and a Claude Code plugin.

## Package Identity

- **Package**: `@tyroneross/bookmark` v0.3.2
- **Runtime**: Node.js >= 20, TypeScript (ESM), no heavy dependencies
- **Entry points**: `dist/index.js` (library), `dist/cli/index.js` (CLI binary), `dist/mcp/server.js` (MCP server)
- **Plugin manifest**: `.claude-plugin/plugin.json`

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # TypeScript compilation + shebang fix on CLI entry
npm run dev          # Watch mode
npm test             # Run tests with vitest
npm run clean        # Remove dist/
npm run mcp          # Start MCP server
```

Build output always goes to `dist/`. Never edit files in `dist/` directly.

## Source Layout

```
src/
├── cli/             # CLI entry point and subcommand dispatch
├── config.ts        # Config loading and storage path resolution
├── index.ts         # Library public API
├── mcp/
│   ├── server.ts    # Single MCP server (dist/mcp/server.js)
│   └── tools.ts     # MCP tool definitions and handlers
├── restore/         # Context restoration logic
├── setup/           # auto-setup.js runs on postinstall
├── snapshot/        # Capture, compress, and storage for snapshots
├── threshold/
│   └── state.ts     # Adaptive threshold and compaction count state
├── trails/          # File change tracking
├── transcript/      # Transcript parsing
└── types.ts         # Shared TypeScript types
```

## Architecture: Plugin vs. npm Package

Bookmark ships both ways from the same source:

| Layer | Files | Purpose |
|-------|-------|---------|
| npm package | `dist/`, `package.json` | CLI, library API, MCP server |
| Claude Code plugin | `.claude-plugin/plugin.json`, `commands/`, `hooks/`, `skills/`, `agents/` | Slash commands, lifecycle hooks, skill, agent |

The plugin manifest at `.claude-plugin/plugin.json` declares metadata only. The actual behavior is in the subdirectories listed below.

## Hooks (4 lifecycle hooks)

Defined in `hooks/hooks.json`. All are `command` type, invoking the CLI via `npx @tyroneross/bookmark <subcommand>`.

| Hook | Subcommand | Behavior |
|------|-----------|---------|
| `Stop` | `stop` | Blocks exit once if `.bookmark/bookmark.context.md` is stale (< 2 min); always approves on retry |
| `PreCompact` | `precompact` | Captures files, emits a `systemMessage` asking Claude to update `bookmark.context.md` |
| `SessionStart` | `restore` | Reads `.bookmark/bookmark.context.md` and injects it as restored context |
| `UserPromptSubmit` | `check` | Async, silent — periodic file change tracking from the transcript |

To change hook behavior, edit `hooks/hooks.json`. Timeouts are in milliseconds (Stop: 10000, PreCompact: 10000, SessionStart: 5000, UserPromptSubmit: 3000 async).

## Commands (5 slash commands)

Each command is a single Markdown file in `commands/`. These files are the single source of truth — they are read by both the plugin system and `npm postinstall`. Do not split logic between a command file and a separate implementation file.

| Command | File | Purpose |
|---------|------|---------|
| `/bookmark:activate` | `commands/activate.md` | Run setup for a project; configure hooks and storage |
| `/bookmark:list` | `commands/list.md` | List all snapshots with timestamps and triggers |
| `/bookmark:restore` | `commands/restore.md` | Load and display snapshot context for continuation |
| `/bookmark:snapshot` | `commands/snapshot.md` | Capture a manual snapshot and write `bookmark.context.md` |
| `/bookmark:status` | `commands/status.md` | Show snapshot stats: count, freshness, thresholds |

## Skill (1)

`skills/context-continuity/SKILL.md` — activates automatically when the user says things like "what was I working on", "restore context", "pick up where I left off", or after a compaction. Not user-invocable directly. Uses MCP tools (`status`, `restore`, `list`, `show`, `snapshot`) to rebuild context.

## Agent (1)

`agents/snapshot-analyst.md` — deep analysis of snapshot history: comparisons across sessions, decision timelines, coverage gaps, context quality assessment. Tools: `Bash`, `Read`, `Glob`, `Grep`.

## MCP Server

Single server at `dist/mcp/server.js`. Start with `npm run mcp` or `node dist/mcp/server.js`.

Five tools exposed:

| Tool | Read-only | Purpose |
|------|-----------|---------|
| `snapshot` | No | Capture session context from transcript |
| `restore` | Yes | Load latest or specific snapshot |
| `status` | Yes | Count, freshness, compaction count, threshold |
| `list` | Yes | Paginated snapshot index |
| `show` | Yes | Full content of a specific snapshot |

Tool definitions and handlers are co-located in `src/mcp/tools.ts`. The server entry point is `src/mcp/server.ts`.

## Storage

All runtime data lives in `.bookmark/` within the project directory. Never write bookmark data to `.claude/`.

```
.bookmark/
├── bookmark.context.md      # Human-written session summary (primary restore artifact)
├── trails/
│   └── files.md             # Automated file change tracking
├── LATEST.md                # Latest compressed snapshot (always-loaded summary)
├── snapshots/               # Full snapshot files (SNAP_*.json, on-demand)
├── index.json               # Snapshot index with metadata (fast lookup)
└── state.json               # Plugin state: compaction_count, threshold, session_history
```

Tiered access pattern: load `LATEST.md` and `bookmark.context.md` always, use `index.json` for lookup, read individual `SNAP_*.json` files only when full detail is needed.

## Adaptive Thresholds

`src/threshold/state.ts` tracks compaction count per session. As compactions accumulate, `current_threshold` tightens (snapshot triggers earlier) and `snapshot_interval_minutes` decreases. This means: the more compactions a session has seen, the more aggressively Bookmark captures context. On session reset, compaction count returns to 0 and thresholds reset.

Default initial state: `current_threshold: 0.20`, `snapshot_interval_minutes: 20`.

## Change Guide

| What you're changing | Where to edit |
|----------------------|---------------|
| Hook behavior or timeouts | `hooks/hooks.json` |
| Slash command instructions | `commands/<name>.md` |
| Skill trigger phrases or workflow | `skills/context-continuity/SKILL.md` |
| MCP tool definitions or handlers | `src/mcp/tools.ts`, then `npm run build` |
| Storage format | Update both read paths (`src/snapshot/storage.ts`, `src/restore/`) and write paths (`src/snapshot/capture.ts`) together |
| Adaptive threshold logic | `src/threshold/state.ts` |
| Plugin metadata | `.claude-plugin/plugin.json` |

Always rebuild (`npm run build`) after editing any `src/` file.

## Storage Format Changes

Storage format changes affect both write (capture) and read (restore/show) paths. When changing snapshot shape:

1. Update `src/types.ts` with the new shape
2. Update `src/snapshot/capture.ts` (write path)
3. Update `src/snapshot/storage.ts` and `src/snapshot/compress.ts` (read/display paths)
4. Update `src/restore/index.js` if the restoration format changes
5. Confirm `src/mcp/tools.ts` handlers still produce valid output

## Testing

Tests use `vitest`. Run with `npm test`. No test fixtures should write to a real `.bookmark/` directory — use temp directories or mocks.

## What Claude Does vs. What the CLI Does

Claude (the running LLM) is responsible for writing `bookmark.context.md` — the human-readable summary. The CLI and hooks handle all mechanical work: transcript parsing, file tracking, JSON snapshot storage, threshold state, and context injection. Do not shift the summary-writing responsibility to CLI automation.
