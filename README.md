# Bookmark

**Context snapshots for Claude Code.**

You've been deep in a coding session. Claude knows your architecture, the decisions you've made, the bugs you've fixed, the open items left. Then the context window compacts — or you close your terminal and come back tomorrow.

Claude forgets everything.

Bookmark fixes this. It captures snapshots of your session context automatically and restores them when you return. No manual steps. No copy-pasting context. You pick up exactly where you left off.

## The Problem

Claude Code sessions are ephemeral. Context is lost when:

- **Compaction happens** — the conversation gets too long and Claude summarizes it, losing detail
- **You close your terminal** — start a new session and Claude has no memory of the last one
- **Your computer restarts** — everything from that deep debugging session is gone
- **You switch between projects** — come back a day later and Claude doesn't know what "we" decided

This creates a painful pattern: every new session starts with you re-explaining what you were working on, what you decided, what's still left to do.

## How Bookmark Works

Bookmark runs as a small external process. Four hooks keep a durable handoff current:

| Hook | When | What |
|------|------|------|
| **PreCompact** | Before context compaction | Captures a mechanical file/tool checkpoint |
| **SessionStart** | New session begins | Restores prior context so Claude knows what you were doing |
| **UserPromptSubmit** | Every user message | Checks time and token thresholds; alerts at 75% used |
| **Stop** | Session ends | Captures files and requires a fresh semantic handoff |

When you open a new terminal and run `claude`, Bookmark restores your prior context. Claude greets you knowing what you were working on, what decisions were made, and what's left to do.

## What Gets Captured

Bookmark separates reliable mechanical evidence from semantic judgment:

- **`bookmark.context.md`** — Claude writes the current task, status, remaining work,
  decisions, risks, open questions, sources of truth, and next steps.
- **JSON snapshots and `LATEST.md`** — Bookmark extracts file changes, tool counts,
  capture reason, model, and measured context usage from the transcript.

The per-prompt threshold check makes no API call and reads only the transcript tail. Full
transcript parsing runs only when an interval or threshold capture is due. The semantic handoff
is capped at 800 tokens and points to source files instead of copying them.

### File paths in snapshots are now project-relative

As of v0.3.3, file paths in `.bookmark/snapshots/SNAP_*.json` are stored
relative to `project_path` (e.g. `src/foo.ts` instead of
`/Users/me/dev/git-folder/myapp/src/foo.ts`). Older snapshots may carry
pre-move absolute paths that went stale when a project was relocated
(e.g. `~/Desktop/git-folder/...` → `~/dev/git-folder/...`); those are not
auto-rewritten — they're left intact so the historical record stays
honest. Going forward, a project move only invalidates `project_path`
itself, not the per-file entries inside each snapshot.

## Install

**Via Claude Code plugin marketplace (recommended):**

```bash
/plugin marketplace add tyroneross/bookmark
/plugin install bookmark@bookmark
```

**Via npm (in a project):**

```bash
npm install @tyroneross/bookmark
```

Hooks are configured automatically. Start a Claude Code session and you're covered.

**Via npm (globally):**

```bash
npm install -g @tyroneross/bookmark
```

Then activate in any project by running `bookmark setup` in your project directory.

## Commands

Use these inside Claude Code:

| Command | What it does |
|---------|-------------|
| `/bookmark` | Show current session context and bookmark status; forwards any arguments to the bookmark CLI |
| `/bookmark:snapshot` | Take a manual snapshot right now |
| `/bookmark:restore` | Restore from latest or a specific snapshot |
| `/bookmark:status` | Show snapshot count, compaction cycles, last snapshot time |
| `/bookmark:list` | List available snapshots with details |

## CLI

```bash
bookmark status              # Show stats
bookmark snapshot            # Take a manual snapshot now
bookmark list                # List snapshots
bookmark show --latest       # Show latest snapshot content
bookmark show SNAP_ID        # Show specific snapshot
bookmark config              # Show current configuration
bookmark config --interval 15  # Change snapshot interval to 15 minutes
bookmark config --token-threshold 75  # Capture and alert at 75% used
bookmark config --context-limit 500000  # Override model context limit
bookmark setup               # Interactive configuration
```

## Token Threshold Capture

Bookmark reads the latest model-reported usage from the Claude Code transcript. It counts input,
cache-read, cache-write, output, and the pending prompt against the active model's context limit.
At 75% used, Bookmark captures a `token_threshold` snapshot, shows a warning, asks Claude to
refresh `bookmark.context.md`, and recommends a new session. It alerts once until a new session
or lower post-compaction usage re-arms the threshold.

Bookmark resolves context limits only for model IDs documented by Anthropic. If the transcript
reports an unknown model, Bookmark pauses token-threshold capture, asks the user for the verified
limit, and keeps manual and periodic snapshots active. It never guesses a context limit. The
mapping follows Anthropic's
[context-window documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows).
Override either value when needed:

```bash
bookmark config --token-threshold 75
bookmark config --context-limit 500000
```

## Hooks

Bookmark installs four hooks because each protects a separate lifecycle boundary:

| Hook | Needed for |
|------|------------|
| `SessionStart` | Restore the latest durable handoff into a new session |
| `UserPromptSubmit` | Run periodic capture and model-aware token-threshold checks |
| `PreCompact` | Save a final mechanical checkpoint before compaction |
| `Stop` | Save at exit and require a complete semantic handoff once |

`UserPromptSubmit` is the only hook required for periodic and token-threshold capture. The other
three complete the restore, pre-compaction, and exit continuity path.

Manual capture does not require another hook: run `/bookmark:snapshot` or `bookmark snapshot`.

## Time-Based Snapshots

Default: every **5 minutes** of active session time. Configurable:

```bash
bookmark config --interval 10   # Every 10 minutes
bookmark config --interval 30   # Every 30 minutes
```

Or set via environment: `BOOKMARK_INTERVAL=15`

## Storage

All data lives in your project at `.bookmark/`:

```
.bookmark/
├── LATEST.md       # Hot context — what gets restored on SessionStart
├── index.json      # Snapshot index with stats
├── state.json      # Plugin state (compaction count, thresholds, timing)
├── config.json     # Your preferences
├── snapshots/      # Full snapshot files
└── archive/        # Old snapshots (>30 days)
```

Automatically added to `.gitignore` — snapshot data never gets committed.

## Identity Block (v0.4+)

Every `bookmark.context.md` should start with an `BOOKMARK_IDENTITY` HTML comment that
declares which project and git state the summary belongs to. This makes cross-session
restoration unambiguous — a bookmark can't be mistaken for a different repo's context.

```markdown
# Session Context — Travel Planner

<!-- BOOKMARK_IDENTITY
scope: repo
project: travel-planner
repo_path: /Users/me/dev/git-folder/Travel Planner
branch: feature/summer-camps
head: 4988383
written: 2026-04-11
-->

## Current Task
...
```

Supported fields: `scope` (`repo` or `home`), `project`, `repo_path`, `repo_name`, `branch`,
`head`, `base`, `written`, `written_by`. Unknown keys are preserved for forward compatibility.

### Path validation

At restore time, bookmark compares the identity's `repo_path` to the CWD it was invoked in.
Mismatch → the restored content is prefixed with an "identity mismatch" warning, so the new
session can verify the bookmark belongs to the project before acting on it.

### Home-scope pointers

A `scope: home` bookmark at `~/.bookmark/bookmark.context.md` is a **pointer**, not a
session context. It contains `points_to_canonical` naming the real repo-scoped file:

```markdown
<!-- BOOKMARK_IDENTITY
scope: home
project: POINTER_ONLY
points_to_project: travel-planner
points_to_canonical: /Users/me/dev/git-folder/Travel Planner/.bookmark/bookmark.context.md
-->
```

SessionStart automatically follows the pointer — a session launched from `~/` now gets
routed to the canonical project bookmark without manual `cd`. Previously, the home
bookmark would be served as if it were the active context (with potentially stale or
wrong-project content).

## Hard Staleness Block (v0.4+)

Stale auto-restore is worse than no auto-restore: a 14-day-old bookmark prefixed with a
soft warning still creates "confident wrong starts" because the warning reads as noise.
Bookmark now **hard-blocks** auto-restore at **72 hours** — past that threshold, the
restored content is replaced with a message telling you to pick a specific snapshot via
`/bookmark:list` or read the file manually if you actually want it. Soft warnings still
apply between 24h and 72h.

## Small Context Footprint

Bookmark performs mechanical capture outside the model context. It injects only the compact
handoff on SessionStart and one short instruction when a token threshold is crossed.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOKMARK_INTERVAL` | `5` | Snapshot interval in minutes |
| `BOOKMARK_TOKEN_THRESHOLD` | `0.75` | Context-used fraction that captures and alerts |
| `BOOKMARK_CONTEXT_LIMIT` | model-aware | Explicit context-window override in tokens |
| `BOOKMARK_STORAGE_PATH` | `.bookmark` | Storage directory |
| `BOOKMARK_VERBOSE` | `false` | Enable verbose logging |
| `BOOKMARK_SKIP_SETUP` | `false` | Skip postinstall auto-setup |

## Requirements

- Node.js >= 20
- Claude Code

## License

Apache-2.0

## Codex

This package now ships an additive Codex plugin surface alongside the existing Claude Code package. The Claude package remains authoritative for Claude behavior; the Codex package adds a parallel `.codex-plugin/plugin.json` install surface without changing the Claude runtime.

Package root for Codex installs:
- the repository root (`.`)

Primary Codex surface:
- skills from `./skills` when present
- MCP config from `./.mcp.json` when present

Install the package from this package root using your current Codex plugin install flow. The Codex package is additive only: Claude-specific hooks, slash commands, and agent wiring remain unchanged for Claude Code.
