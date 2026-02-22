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

**Install it. Forget about it. It just works.**

Bookmark runs as an external process — zero tokens consumed from your context window. Four hooks handle everything automatically:

| Hook | When | What |
|------|------|------|
| **PreCompact** | Before context compaction | Captures full context before it's compressed |
| **SessionStart** | New session begins | Restores prior context so Claude knows what you were doing |
| **UserPromptSubmit** | Every user message | Checks if a time-based snapshot is due |
| **Stop** | Session ends | Final snapshot preserving everything |

When you open a new terminal and run `claude`, Bookmark restores your prior context. Claude greets you knowing what you were working on, what decisions were made, and what's left to do.

## What Gets Captured

Each snapshot extracts from the conversation transcript — no LLM calls needed:

- **Decisions made** — "chose Postgres over SQLite because...", "going with React Query for..."
- **Current status** — what was being worked on when the session ended
- **Open items** — TODOs, next steps, unfinished work
- **Unknowns and blockers** — things that were unclear or blocking progress
- **Files changed** — which files were created, edited, or read
- **Errors encountered** — what broke and whether it was resolved
- **Tool usage** — aggregate counts of Read, Edit, Bash, etc.

All extraction uses pattern matching on the transcript. Zero API calls, zero cost, zero latency.

## Install

**In a project (recommended):**

```bash
npm install @tyroneross/bookmark
```

Hooks are configured automatically. Start a Claude Code session and you're covered.

**Globally:**

```bash
npm install -g @tyroneross/bookmark
```

Then activate in any project by typing `/bookmark:activate` in a Claude Code session, or run `bookmark setup` in your project directory.

**As a Claude Code plugin:**

```bash
claude plugin add github.com/tyroneross/bookmark
```

## Commands

Use these inside Claude Code:

| Command | What it does |
|---------|-------------|
| `/bookmark:snapshot` | Take a manual snapshot right now |
| `/bookmark:restore` | Restore from latest or a specific snapshot |
| `/bookmark:status` | Show snapshot count, compaction cycles, last snapshot time |
| `/bookmark:list` | List available snapshots with details |
| `/bookmark:activate` | Set up Bookmark for the current project |

## CLI

```bash
bookmark status              # Show stats
bookmark list                # List snapshots
bookmark show --latest       # Show latest snapshot content
bookmark show SNAP_ID        # Show specific snapshot
bookmark config              # Show current configuration
bookmark config --interval 15  # Change snapshot interval to 15 minutes
bookmark setup               # Interactive configuration
```

## Adaptive Thresholds

Bookmark gets smarter the more your context compacts. It tracks compaction cycles and adjusts when snapshots trigger:

| Compaction count | Snapshot triggers at | Behavior |
|-----------------|---------------------|----------|
| 0 (never compacted) | 20% context remaining | Conservative — only near compaction |
| 1 (once) | 30% remaining | Earlier snapshots |
| 2 (twice) | 40% remaining | Even earlier |
| 3+ (frequent) | 50% remaining | Aggressive — snapshot at halfway |

Sessions that compact frequently get protected more aggressively. Sessions that never compact barely notice Bookmark is there.

## Time-Based Snapshots

Default: every **20 minutes** of active session time. Configurable:

```bash
bookmark config --interval 10   # Every 10 minutes
bookmark config --interval 30   # Every 30 minutes
```

Or set via environment: `BOOKMARK_INTERVAL=15`

## Smart Mode (Optional)

For higher-quality extraction, pass `--smart` to use Claude Haiku (~$0.001 per snapshot):

```bash
bookmark config --smart-default   # Enable by default
```

Requires `ANTHROPIC_API_KEY`. Falls back to pattern matching if unavailable.

## Storage

All data lives in your project at `.claude/bookmarks/`:

```
.claude/bookmarks/
├── LATEST.md       # Hot context — what gets restored on SessionStart
├── index.json      # Snapshot index with stats
├── state.json      # Plugin state (compaction count, thresholds, timing)
├── config.json     # Your preferences
├── snapshots/      # Full snapshot files
└── archive/        # Old snapshots (>30 days)
```

Automatically added to `.gitignore` — snapshot data never gets committed.

## Zero Context Tax

This is the key design principle. Every other approach to "memory" for Claude Code injects tokens into your context window, reducing the space available for actual work.

Bookmark runs as an external CLI process. The hooks invoke `npx @tyroneross/bookmark` — a separate Node process that reads the transcript file directly, extracts patterns, and writes snapshot files. The only context injection is ~500-800 tokens on SessionStart to restore prior session context.

All the heavy lifting happens outside the context window.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOKMARK_INTERVAL` | `20` | Snapshot interval in minutes |
| `BOOKMARK_THRESHOLD` | `0.2,0.3,0.4,0.5,0.6` | Adaptive threshold levels |
| `BOOKMARK_CONTEXT_LIMIT` | `200000` | Context window size in tokens |
| `BOOKMARK_SMART` | `false` | Enable smart extraction by default |
| `BOOKMARK_STORAGE_PATH` | `.claude/bookmarks` | Storage directory |
| `BOOKMARK_VERBOSE` | `false` | Enable verbose logging |
| `BOOKMARK_SKIP_SETUP` | `false` | Skip postinstall auto-setup |

## Requirements

- Node.js >= 20
- Claude Code

## License

MIT
