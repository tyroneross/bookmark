---
description: "Take a manual context snapshot"
allowed-tools: Bash
argument-hint: "[--smart]"
---

Take a manual context snapshot of the current session.

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
- Number of decisions captured
- Number of files tracked
- Number of open items
- Context remaining percentage

*bookmark — context snapshot*
