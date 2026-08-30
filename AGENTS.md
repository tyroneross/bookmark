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
│   ├── state.ts     # Session, compaction, and threshold notification state
│   ├── time-based.ts
│   └── token-usage.ts # Model-aware transcript usage measurement
├── context/
│   └── handoff-prompt.ts # Compact semantic handoff contract
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
| `Stop` | `stop` | Blocks exit once unless the handoff is under 2 minutes old and contains identity plus all required sections; always approves on retry |
| `PreCompact` | `precompact` | Captures a mechanical file/tool checkpoint; Claude Code discards PreCompact messages |
| `SessionStart` | `restore` | Reads `.bookmark/bookmark.context.md` and injects it as restored context |
| `UserPromptSubmit` | `context-check` | Measures context usage, handles interval capture, and alerts once at each configured token threshold |

To change hook behavior, edit `hooks/hooks.json`. Timeouts are in milliseconds (Stop: 10000, PreCompact: 10000, SessionStart: 5000, UserPromptSubmit: 10000).

## Commands (6 slash commands, down from 8)

Each command is a single Markdown file in `commands/`. These files are the single source of truth for the plugin system. `activate` and `verify` were removed (2026 surface reduction — zero recorded uses across 1,663 mined sessions, and neither was referenced by any script/hook/agent). `list`, `restore`, `snapshot`, and `status` were kept even though the target is a single router entry point, because `src/setup/auto-setup.ts`, `src/cli/index.ts`, `src/restore/index.ts`, and `scripts/install-plugin.sh` all print these exact slash-command names to users at runtime — deleting the files would leave the CLI recommending dead commands. Do not split logic between a command file and a separate implementation file.

| Command | File | Purpose |
|---------|------|---------|
| `/bookmark:bookmark` | `commands/bookmark.md` | Router / bare command — show current session context and bookmark status, or forward arguments to the CLI |
| `/bookmark:list` | `commands/list.md` | List all snapshots with timestamps and triggers |
| `/bookmark:restore` | `commands/restore.md` | Load and display snapshot context for continuation |
| `/bookmark:snapshot` | `commands/snapshot.md` | Capture a manual snapshot and write `bookmark.context.md` |
| `/bookmark:status` | `commands/status.md` | Show snapshot stats: count, freshness, thresholds |
| `/bookmark:feedback` | `commands/feedback.md` | Report a bug or send feedback |

To activate Bookmark for a project without the removed `/bookmark:activate` command, run
`npx @tyroneross/bookmark setup --defaults` directly (that's all the command ever did).

## Key behaviors (Codex must honor)

### Identity block — required in every `bookmark.context.md`

Every `bookmark.context.md` must start with a `BOOKMARK_IDENTITY` HTML comment. Without it
the restore path treats the file as legacy and skips path validation entirely.

```markdown
<!-- BOOKMARK_IDENTITY
scope: repo
project: my-app
repo_path: /Users/me/dev/git-folder/my-app
branch: main
head: abc1234
written: 2026-05-30
-->
```

Supported fields (defined in `src/trails/identity.ts` `BookmarkIdentity`):

| Field | Required | Notes |
|-------|----------|-------|
| `scope` | Yes | `repo` (active context) or `home` (pointer only) |
| `project` | Yes | Short kebab-case project name |
| `repo_path` | Yes | Absolute path — used for path validation at restore |
| `branch` | Recommended | Git branch at write time |
| `head` | Recommended | Short commit SHA at write time |
| `base` | Optional | Base branch / merge base |
| `written` | Recommended | ISO date (`YYYY-MM-DD`) |
| `written_by` | Optional | Agent or human that wrote it |

Unknown keys are preserved for forward compatibility. The parser is in
`src/trails/identity.ts` (`parseIdentity`).

**Path validation**: at restore, if `repo_path` disagrees with the CWD (and CWD is not a
subdirectory of it), the restored content is prefixed with an identity-mismatch warning.
Agents must not treat a mismatched restore as authoritative without surfacing the warning to
the user.

**Home-scope pointers**: a `scope: home` file declares `points_to_canonical` pointing at the
repo-scoped file. SessionStart follows the pointer automatically; the pointer body itself is
never served as active session context.

### Hard staleness block — 72 hours

Source constant: `STALENESS_HARD_BLOCK_HOURS = 72` in `src/restore/index.ts`.

| Age | Behavior |
|-----|----------|
| < 24 h | Restored normally |
| 24 h – < 72 h | Restored with a soft warning noting age |
| ≥ 72 h | **Auto-restore is blocked.** The session receives a staleness message instead of the stale content, directing the user to `/bookmark:list` or manual file read. |

**Codex rule**: do NOT surface a ≥ 72 h bookmark as current session context. The hard block
exists because a soft warning on a 14-day-old file creates a confident wrong start — the
warning reads as noise and the agent acts on stale facts. When the restore path returns a
staleness message, present it verbatim and prompt the user for direction rather than
proceeding on the old context.

### Durability quality check

No slash command for this (removed in the 0.4 surface reduction — zero recorded uses across
1,663 mined sessions). Run the checker directly after writing `bookmark.context.md` to confirm
it will survive a cold restart:

```bash
python3 ~/.claude/scripts/bookmark-verify.py
```

Checks five rules: (1) absolute paths only, (2) no volatile TaskList IDs, (3) `## Next steps`
section with at least one file path, (4) `## Sources of truth` section present,
(5) no relative time references (yesterday / last week / earlier today). Exits non-zero on
FAIL and prints line numbers + rule violations. JSON snapshot paths (`.json`) are rejected
with exit code 3 — the verifier targets the rendered `.md` file only.

### `~/.bookmark/registry.json` — cross-project discovery

`src/registry.ts` maintains a global registry at `~/.bookmark/registry.json` (up to 500
entries). `last_project` records the most recently active project path and name. Agents can
read this to locate a project's canonical bookmark when the CWD is unknown.

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

## Token Thresholds

`src/threshold/token-usage.ts` reads the latest model ID and usage record from the transcript tail. Input, cache-read, cache-write, output, and pending-prompt tokens count toward the context window. The default new-session threshold is 75% used. `src/threshold/state.ts` records which thresholds fired; a new session clears them immediately, while compaction re-arms them after a lower post-compaction usage record appears. This suppresses alerts from a stale pre-compaction record.

Default state: `tokenThresholds: [0.75]`, `snapshot_interval_minutes: 5`. Bookmark resolves only documented model limits. An unknown model pauses token-threshold capture and prompts the user to set `BOOKMARK_CONTEXT_LIMIT` or the project `contextLimitTokens`; manual and periodic snapshots continue.

## Change Guide

| What you're changing | Where to edit |
|----------------------|---------------|
| Hook behavior or timeouts | `hooks/hooks.json` |
| Slash command instructions | `commands/<name>.md` |
| Skill trigger phrases or workflow | `skills/context-continuity/SKILL.md` |
| MCP tool definitions or handlers | `src/mcp/tools.ts`, then `npm run build` |
| Storage format | Update both read paths (`src/snapshot/storage.ts`, `src/restore/`) and write paths (`src/snapshot/capture.ts`) together |
| Token threshold/model-limit logic | `src/threshold/token-usage.ts`, `src/threshold/state.ts` |
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
