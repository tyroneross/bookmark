---
description: "Show current session context and bookmark status"
allowed-tools: Bash, Read
---

Show the current bookmark state for this project.

{{#if ARGUMENTS}}
Pass arguments to the bookmark CLI:

```bash
npx @tyroneross/bookmark {{ARGUMENTS}}
```
{{else}}
Run status and show current context:

```bash
npx @tyroneross/bookmark status
```

Then check if `.bookmark/bookmark.context.md` exists in the current project and read it to show the user their last session context.

Present:
- Snapshot count and last snapshot time
- Current session context summary (from bookmark.context.md) if it exists
- Available commands: `/bookmark:snapshot`, `/bookmark:status`, `/bookmark:list`, `/bookmark:restore`
{{/if}}

*bookmark — session continuity*
