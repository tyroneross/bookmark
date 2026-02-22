---
name: context-continuity
description: This skill activates when the user mentions "what was I working on", "continue from last session", "restore context", "what did we decide", "pick up where I left off", "compaction happened", "lost context", "session context", or when resuming work after a break. Provides session continuity by accessing bookmark snapshots.
version: 0.1.0
---

# Context Continuity Workflow

This skill helps restore and maintain context across Claude Code sessions and compactions.

## When to Activate

- User asks about prior session work
- User wants to continue a previous task
- After compaction when context was compressed
- User reports "losing" context or decisions

## Restoration Flow

1. Check for existing snapshots:
```bash
npx @tyroneross/bookmark status
```

2. If snapshots exist, read the hot context:
```bash
npx @tyroneross/bookmark show --latest
```

3. Present the restored context to the user:
   - **Current Status**: What was being worked on
   - **Decisions Made**: Key choices with rationale
   - **Open Items**: What still needs doing
   - **Unknowns**: Blockers or questions

4. Ask the user which open item to continue with.

## After Restoration

Once context is restored, continue working normally. The automatic hooks handle future snapshots.

## Manual Snapshot

If the user wants to explicitly save context before a break:
```bash
npx @tyroneross/bookmark snapshot --trigger manual
```

*bookmark — context snapshot*
