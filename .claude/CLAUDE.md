## Bookmark — Context Snapshots

This project uses @tyroneross/bookmark for context snapshots.

**Automatic behavior:**
- Snapshots captured before compaction and on session end
- CONTEXT.md restored on session start (~400 tokens, trailhead with routing)
- Trail files (decisions.md, files.md) available for deeper context via Read tool
- No external API calls — you interpret the trails naturally

**Trail routing:**
- `CONTEXT.md` has intent, progress, and pointers to trail files
- Follow `trails/decisions.md` for timestamped decision history
- Follow `trails/files.md` for cumulative file change details
- Only read trails if the trailhead isn't enough

**Commands:**
- `/bookmark:snapshot` — Manual snapshot
- `/bookmark:restore` — Restore from a snapshot
- `/bookmark:status` — Show snapshot stats
- `/bookmark:list` — List all snapshots
