---
description: "Verify bookmark.context.md content quality (durability checks)"
allowed-tools: Bash, Read
---

Run content-quality verification on a bookmark snapshot. Checks the same five rules that make a bookmark survive a cold restart:

1. Absolute paths only (no `~/...` references that depend on shell expansion).
2. No TaskList ID strings (task #N) — task IDs are volatile.
3. `## Next steps` section present and contains at least one file path.
4. `## Sources of truth` section present.
5. No relative time references (yesterday, last week, earlier today, etc.).

{{#if ARGUMENTS}}
Verify the snapshot at the given path:

```bash
python3 /Users/tyroneross/.claude/scripts/bookmark-verify.py {{ARGUMENTS}}
```
{{else}}
Verify the current project's bookmark.context.md (defaults to `./.bookmark/bookmark.context.md`):

```bash
python3 /Users/tyroneross/.claude/scripts/bookmark-verify.py
```
{{/if}}

Report the result inline. On `FAIL`, list the line numbers and which rule each finding violates so the user can edit the bookmark and re-run. On `PASS`, confirm the snapshot meets the durability bar.

If the user wants to verify a specific historical snapshot, they can pass the path:
`/bookmark:verify /Users/<name>/<repo>/.bookmark/snapshots/SNAP_<id>.json` — note that snapshot JSON files are not the same shape as `bookmark.context.md`, so this command targets the live `bookmark.context.md` by default.

**JSON input handling:** if the path passed ends in `.json`, the verifier detects the wrong-shape input, prints a one-line redirect (`use ./.bookmark/bookmark.context.md or pass the rendered .md path`), and exits non-zero (code 3) so callers know nothing was actually verified. Don't attempt to parse JSON snapshots against the markdown durability rules — the rules don't map.

*bookmark — durability verifier (B1, week-2 plan)*
