---
description: "Restore context from a snapshot"
allowed-tools: Bash, Read
argument-hint: "[SNAP_ID]"
---

{{#if ARGUMENTS}}
Load and display the full context from a specific snapshot:

```bash
npx @tyroneross/bookmark show {{ARGUMENTS}}
```

Read the snapshot and present the decisions, status, open items, and unknowns to the user. Use this context to continue the work.

{{else}}
Show the latest snapshot and list available alternatives:

```bash
npx @tyroneross/bookmark show --latest
```

```bash
npx @tyroneross/bookmark list --limit 5
```

Present the restored context and ask the user which open item to continue with.
{{/if}}

*bookmark — context snapshot*
