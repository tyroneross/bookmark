# Bookmark — Session Continuity for Claude Code

## What Bookmark Does

Bookmark preserves session context across terminal closures and compactions. You (Claude) write a brief summary to CONTEXT.md before stopping or compacting. On the next session start, that summary is restored so you can pick up where you left off.

## How It Works

**Hooks** (configured in settings.json, all command-type):
- **Stop** — Blocks once if CONTEXT.md is stale, asking you to write it before exit
- **PreCompact** — Captures files, sends systemMessage asking for CONTEXT.md update
- **SessionStart** — Restores CONTEXT.md content on startup, cleans session state
- **UserPromptSubmit** — Periodic file change tracking (async, silent)

**You write the summary.** The Stop hook blocks exit once if you haven't written `.claude/bookmarks/CONTEXT.md` recently (<2 min). Write task status, progress, decisions, and files modified. On retry, it always approves (max 1 block).

**File tracking is automatic.** The UserPromptSubmit hook captures file changes and tool usage from the transcript. This data supplements your summary in `trails/files.md`.

## Storage

```
.claude/bookmarks/
├── CONTEXT.md      ← Your session summary (you write this)
├── trails/
│   └── files.md    ← Automated file change tracking
├── LATEST.md       ← File tracking snapshot
├── snapshots/      ← Historical snapshots (SNAP_*.json)
├── index.json      ← Snapshot index
└── state.json      ← Plugin state
```

## Commands

| Command | Purpose |
|---------|---------|
| `/bookmark:snapshot` | Manual snapshot + write CONTEXT.md |
| `/bookmark:status` | Show snapshot stats |
| `/bookmark:list` | List all snapshots |

*bookmark — session continuity*
