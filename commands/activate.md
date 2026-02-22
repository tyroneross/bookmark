---
description: "Activate Bookmark context snapshots for this project"
allowed-tools: Bash
---

Activate Bookmark (context snapshots) for the current project. This configures hooks, creates storage directories, and sets up automatic context capture.

Run the setup command:

```bash
npx @tyroneross/bookmark setup --defaults
```

After activation, confirm to the user:
- Bookmark is now active for this project
- Snapshots will be captured automatically before compaction, on 20-minute intervals, and at session end
- Context will be restored automatically when starting a new session
- Available commands: `/bookmark:snapshot`, `/bookmark:status`, `/bookmark:list`, `/bookmark:restore`

*bookmark — context snapshot*
