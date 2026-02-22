# Bookmark — Context Snapshots for Claude Code

## What Bookmark Does

Bookmark automatically captures, compresses, and restores session context so you never lose progress across compactions, terminal closures, or computer shutdowns.

## How It Works

**Automatic hooks** (zero context window tax):
- **PreCompact** — Snapshots before compaction (async, external process)
- **SessionStart** — Restores context from latest snapshot
- **UserPromptSubmit** — Checks time/threshold intervals (fast no-op when nothing triggers)
- **Stop** — Final snapshot before session ends

**Adaptive thresholds** — Snapshots trigger earlier as compaction happens more:
- 1st compaction: snapshot at 20% remaining
- 2nd: 30% remaining
- 3rd+: 40-50% remaining

**Time-based intervals** — Default every 20 minutes (configurable).

## Storage Location

All data lives in `<project>/.claude/bookmarks/`:
```
.claude/bookmarks/
├── LATEST.md       ← Read this first (hot context, <150 lines)
├── index.json      ← Snapshot index
├── state.json      ← Plugin state
├── snapshots/      ← Full snapshot files (SNAP_*.json)
└── archive/        ← Old snapshots
```

## Available Commands

| Command | Purpose |
|---------|---------|
| `/bookmark:snapshot` | Take a manual snapshot |
| `/bookmark:restore` | Restore from latest or specific snapshot |
| `/bookmark:status` | Show snapshot inventory and stats |
| `/bookmark:list` | List all snapshots |

## CLI Quick Reference

```bash
npx @tyroneross/bookmark status          # Stats
npx @tyroneross/bookmark list            # List snapshots
npx @tyroneross/bookmark show --latest   # Show latest snapshot
npx @tyroneross/bookmark show <SNAP_ID>  # Show specific snapshot
npx @tyroneross/bookmark config          # Show/set configuration
npx @tyroneross/bookmark init            # Initialize in project
```

## What Gets Captured

Each snapshot extracts from the transcript:
- **Current status** — What was being worked on
- **Decisions made** — Key choices with rationale
- **Open items** — TODOs with priority
- **Unknowns/blockers** — Uncertainties and blockers
- **Files changed** — With operation types
- **Errors encountered** — Resolved vs unresolved
- **Tool usage summary** — Aggregate tool call counts

## Smart Mode

Pass `--smart` to use Claude Haiku for higher-quality extraction (~$0.001/snapshot). Requires `ANTHROPIC_API_KEY`.

*bookmark — context snapshot*
