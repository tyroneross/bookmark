---
name: context-continuity
description: Use when the user asks "what was I working on", "continue from last session", "restore context", "pick up where I left off", or after compaction/lost context. Restores session via bookmark snapshots.
version: 0.2.0
user-invocable: false
---

# Context Continuity Workflow

This skill restores and maintains context across Claude Code sessions and compactions using the Bookmark MCP tools.

## When to Activate

- User asks about prior session work or decisions
- User wants to continue a previous task
- After compaction when context was compressed
- User reports "losing" context or decisions
- Session start when prior context exists

## Restoration Flow

### 1. Check snapshot inventory

Use the `bookmark status` MCP tool to check if snapshots exist and how fresh they are.

The status tool returns: snapshot count, last capture time, freshness, compaction count, and current threshold.

### 2. Restore context

Use the `bookmark restore` MCP tool to load the latest session context. This returns a structured summary optimized for continuation:
- **Current Status**: What was being worked on
- **Decisions Made**: Key choices with rationale
- **Open Items**: What still needs doing
- **Unknowns**: Blockers or questions
- **Files Changed**: What was modified

### 3. Present and continue

Summarize the restored context to the user. Ask which open item to continue with, or if the user has a new direction.

## Browsing History

To list available snapshots and view a specific one:

1. Use the `bookmark list` MCP tool to see all snapshots with timestamps and triggers
2. Use the `bookmark show` MCP tool with a snapshot_id to view full content of a specific snapshot

## Manual Snapshot

If the user wants to explicitly save context before a break:

Use the `bookmark snapshot` MCP tool with trigger "manual" to capture current session state.

## After Restoration

Once context is restored, continue working normally. The automatic hooks handle future snapshots — no manual intervention needed.

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `status` | Snapshot inventory — count, freshness, thresholds |
| `restore` | Load latest or specific snapshot context for continuation |
| `list` | Browse all snapshots with metadata |
| `show` | View full content of a specific snapshot |
| `snapshot` | Capture a manual snapshot of current session |

*bookmark — session continuity*
