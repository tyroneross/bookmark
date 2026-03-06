---
description: "Take a manual context snapshot and write session summary"
allowed-tools: Bash, Write
---

Take a manual context snapshot. This captures file changes and tool usage from the current session transcript.

{{#if ARGUMENTS}}
```bash
npx @tyroneross/bookmark snapshot --trigger manual {{ARGUMENTS}}
```
{{else}}
```bash
npx @tyroneross/bookmark snapshot --trigger manual
```
{{/if}}

After the snapshot is taken, confirm to the user with:
- The snapshot ID
- Number of files tracked
- Number of tools tracked

Then write a brief session summary to `.claude/bookmarks/CONTEXT.md` that includes:
- Current task (what the user asked for)
- Progress (what's done, what's remaining)
- Key decisions made and rationale
- Active git branch if applicable
- Files modified (top 5-10 by importance)

Keep the CONTEXT.md under 30 lines. This is the primary artifact that restores context on the next session start.

*bookmark — context snapshot*
