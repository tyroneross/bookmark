---
description: "Activate Bookmark context snapshots for this project"
allowed-tools: Bash
---

Activate Bookmark for the current project. This configures hooks, creates storage directories, captures mechanical checkpoints every five minutes, and recommends a new session after a 75%-used context checkpoint.

Run the setup command with current defaults:

```bash
npx @tyroneross/bookmark setup --defaults
```

`setup --defaults` configures the five-minute mechanical interval and the 75%-used new-session threshold.

After activation, confirm to the user:
- Bookmark is now active for this project
- Mechanical snapshots run before compaction, every **five minutes**, at 75% context used, and at session end
- At 75%, Claude refreshes the compact semantic handoff and tells the user how to start a clean session
- Context will be restored automatically when starting a new session
- Available commands: `/bookmark:snapshot`, `/bookmark:status`, `/bookmark:list`, `/bookmark:restore`
- To change the interval later: `npx @tyroneross/bookmark config --interval <minutes>`

*bookmark — context snapshot*
