---
description: "Restore context from a snapshot"
allowed-tools: Bash, Read
argument-hint: "[SNAP_ID]"
---

{{#if ARGUMENTS}}
Load and display the full context from a specific snapshot. If the ID lives in a
different project, `show` will resolve it via the global registry.

```bash
npx @tyroneross/bookmark show {{ARGUMENTS}}
```

Read the snapshot and present the decisions, status, open items, and unknowns to the user.

{{else}}
Restore the most relevant context, using the same resolution chain as session startup
(current project → home-scope pointer → last-active project via registry):

```bash
npx @tyroneross/bookmark restore --session-source clear
```

If you want to pick a different snapshot, list recent ones:

```bash
npx @tyroneross/bookmark list --limit 5
```

Or view snapshots across all projects:

```bash
npx @tyroneross/bookmark list --all --limit 10
```

Present the restored context and ask the user which open item to continue with.
{{/if}}

*bookmark — context snapshot*
