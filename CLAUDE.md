<!-- Plugin: bookmark · Version: 0.3.3 · Source of truth: local (~/dev/git-folder/bookmark) -->
<!-- Before any commit, version bump, or major change, read ./VERSIONING.md. Update it on version bumps. -->

# Bookmark — Session Continuity for Claude Code

## What Bookmark Does

Bookmark preserves session context across terminal closures and compactions. You (Claude) refresh `bookmark.context.md` when the token threshold fires and before stopping. A mechanical PreCompact snapshot preserves file/tool evidence. On the next session start, the semantic handoff is restored so you can pick up where you left off.

## How It Works

**Hooks** (configured in settings.json, all command-type):
- **Stop** — Blocks once if bookmark.context.md is stale, asking you to write it before exit
- **PreCompact** — Captures a mechanical file/tool checkpoint before compaction
- **SessionStart** — Restores bookmark.context.md content on startup, cleans session state
- **UserPromptSubmit** — Measures transcript usage, captures time-based checkpoints, and at 75% asks you to refresh the handoff and recommend a new session

**You write the summary.** The Stop hook blocks exit once if `.bookmark/bookmark.context.md` is stale (<2 min). Keep the handoff under 800 tokens with current task, status, remaining work, decisions, risks and open questions, sources of truth, and next steps. Separate completed, validated, committed, pushed, and deployed work. Use absolute file paths and durable pointers. On retry, Stop always approves (max 1 block).

**File tracking is automatic.** The UserPromptSubmit hook captures file changes and tool usage when its interval or token threshold is due. This data supplements your summary in `trails/files.md`.

## Identity Block (v0.4+)

Start every `bookmark.context.md` with an identity block so restoration is unambiguous:

```markdown
# Session Context — Project Name

<!-- BOOKMARK_IDENTITY
scope: repo
project: travel-planner
repo_path: /Users/me/Desktop/git-folder/Travel Planner
branch: feature/summer-camps
head: 4988383
written: 2026-04-11
-->

## Current Task
...
```

Fields:
- `scope` — `repo` (normal, attached to a project) or `home` (pointer only — see below)
- `project` — short canonical project name (kebab-case)
- `repo_path` — absolute path to the repo/directory the bookmark describes
- `branch`, `head`, `base` — git info at write time
- `written`, `written_by` — provenance

**Path validation**: If `repo_path` disagrees with the CWD at restore time, the restored
content is prefixed with an "identity mismatch" warning so you can verify you're in the
right project before acting on it. Catches the case where you moved the file or started
Claude Code from the wrong directory.

## Home-Scope Pointers

A bookmark file at `~/.bookmark/bookmark.context.md` with `scope: home` is a **pointer**,
not a session context. It declares `points_to_canonical` pointing at the real repo-scope
bookmark:

```markdown
<!-- BOOKMARK_IDENTITY
scope: home
project: POINTER_ONLY
points_to_project: travel-planner
points_to_canonical: /Users/me/Desktop/git-folder/Travel Planner/.bookmark/bookmark.context.md
-->
```

SessionStart follows the pointer automatically: when it sees `scope: home`, it reads the
target file and serves its content instead, prefixed with a one-line header noting which
canonical file was followed. This means a session launched from `~/` gets routed to the
correct active project's bookmark without manual `cd`.

## Hard Staleness Block (v0.4+)

Soft warnings on stale content create "confident wrong starts" — Claude treats a 14-day-old
context as current because the warning looks like noise. Bookmark now hard-blocks auto-restore
at **72 hours**: past that threshold, the restore returns a staleness message instead of the
stale content, telling you to pick a specific snapshot or read the file manually if you
actually want it. Soft warnings still apply at 24h.

## Storage

```
.bookmark/
├── bookmark.context.md      ← Your session summary (you write this)
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
| `/bookmark:snapshot` | Manual snapshot + write bookmark.context.md |
| `/bookmark:status` | Show snapshot stats |
| `/bookmark:list` | List all snapshots |

*bookmark — session continuity*
