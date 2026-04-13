---
description: "Activate Bookmark context snapshots for this project"
allowed-tools: Bash
---

Activate Bookmark (context snapshots) for the current project. This configures hooks, creates storage directories, and sets up automatic context capture at a 10-minute snapshot interval.

Run the setup command, then override the interval to 10 minutes:

```bash
npx @tyroneross/bookmark setup --defaults && npx @tyroneross/bookmark config --interval 10
```

The two-step sequence exists because `setup --defaults` ships with a 20-minute interval to match the broader bookmark CLI's conservative default. `/bookmark:activate` is opinionated — slash-command users expect more frequent capture, so we immediately override to 10 minutes once setup has written the initial state file.

After activation, confirm to the user:
- Bookmark is now active for this project
- Snapshots will be captured automatically before compaction, on **10-minute intervals**, and at session end
- Context will be restored automatically when starting a new session
- Available commands: `/bookmark:snapshot`, `/bookmark:status`, `/bookmark:list`, `/bookmark:restore`
- To change the interval later: `npx @tyroneross/bookmark config --interval <minutes>`

*bookmark — context snapshot*
