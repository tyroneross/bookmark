# Bookmark — Context Snapshots for Claude Code

## What Bookmark Does

Bookmark automatically captures, compresses, and restores session context so you never lose progress across compactions, terminal closures, or computer shutdowns.

## How It Works

**Automatic hooks** (zero context window tax):
- **PreCompact** — Snapshots before compaction (async, external process)
- **SessionStart** — Restores context from CONTEXT.md (trailhead)
- **UserPromptSubmit** — Checks time/threshold intervals (fast no-op when nothing triggers)
- **Stop** — Final snapshot before session ends

**Trail-routed memory** — Context stored in a hierarchy of navigable files:
- `CONTEXT.md` — Compact trailhead (~400 tokens), always restored on session start
- `trails/decisions.md` — Timestamped decision chain, newer overrides older on same topic
- `trails/files.md` — Cumulative file activity sorted by impact

**No external API calls** — You (Claude Code) are the interpreter. Pattern matching captures structured data during snapshots. You interpret the trails on restore.

**Adaptive thresholds** — Snapshots trigger earlier as compaction happens more:
- 1st compaction: snapshot at 20% remaining
- 2nd: 30% remaining
- 3rd+: 40-50% remaining

## Storage Location

All data lives in `<project>/.claude/bookmarks/`:
```
.claude/bookmarks/
├── CONTEXT.md      ← Trailhead — read this on restore (~400 tokens)
├── trails/
│   ├── decisions.md ← Follow for decision history
│   └── files.md     ← Follow for file change details
├── LATEST.md       ← Flat markdown backup
├── index.json      ← Snapshot index
├── state.json      ← Plugin state
├── snapshots/      ← Full snapshot files (SNAP_*.json)
└── archive/        ← Old snapshots
```

## How to Use Trails

When CONTEXT.md is restored, it contains routing pointers to trail files. If you need more detail:
1. Read the trailhead (CONTEXT.md) — usually enough to resume
2. Follow `trails/decisions.md` if you need decision history or rationale
3. Follow `trails/files.md` if you need to know what files were modified and how much

## Available Commands

| Command | Purpose |
|---------|---------|
| `/bookmark:snapshot` | Take a manual snapshot |
| `/bookmark:restore` | Restore from latest or specific snapshot |
| `/bookmark:status` | Show snapshot inventory and stats |
| `/bookmark:list` | List all snapshots |

*bookmark — context snapshot*
