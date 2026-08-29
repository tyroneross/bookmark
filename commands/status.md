---
description: "Show bookmark snapshot inventory"
allowed-tools: Bash
---

Show the current state of context snapshots:

```bash
npx @tyroneross/bookmark status
```

Display the results including:
- Number of snapshots
- Compaction cycle count
- Last snapshot time
- Current token threshold, measured usage, and active model when available
- Time until next scheduled snapshot

*bookmark — context snapshot*
