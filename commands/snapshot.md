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

Then write the semantic handoff to the absolute path for `.bookmark/bookmark.context.md`.
Start with `BOOKMARK_IDENTITY` and include these sections:

- `## Current task`
- `## Status`
- `## Remaining work`
- `## Decisions`
- `## Risks and open questions`
- `## Sources of truth`
- `## Next steps`

Separate completed, validated, committed, pushed, and deployed status. Use absolute paths in
Sources of truth and Next steps. Point to durable files instead of copying long content, state
unknowns explicitly, and keep the handoff under 800 tokens.

*bookmark — context snapshot*
