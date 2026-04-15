# Snapshot Architecture — Project-Named Storage + Global Registry

> Status: Draft plan. Not yet executed.
> Target release: v0.5.0

## Context

Today, snapshot discovery is CWD-scoped. A snapshot captured in project X is only
findable when running a bookmark command from inside X. From any other CWD, `list`,
`show`, and `status` return nothing or return the wrong dataset.

The trigger case: a manual snapshot taken while working on `~/Documents/Obsidian Vault`
(ID `SNAP_20260414_222429`) was correctly stored at
`Obsidian Vault/.bookmark/snapshots/` but was invisible to `/bookmark:list` run from
`~/`. The snapshot was never lost — the directory schema makes cross-project discovery
impossible without `cd`.

Full investigation: see session notes 2026-04-14.

## Goals

1. Every snapshot file is self-identifying — its name embeds the project so a misplaced
   or referenced file is never ambiguous.
2. Snapshots stay with their source repo (portable, committable, project-owned).
3. A machine-wide registry answers "where does snapshot `SNAP_*` live?" without a CWD
   hunt.
4. Home-scope data (`~/.bookmark/`) is cleanly separated: pointer + global registry
   live there, but home-CWD snapshot *content* does not mix with either.
5. Slash commands (`/bookmark:list`, `/bookmark:show`, `/bookmark:restore`) work from
   any CWD and degrade gracefully through pointer → registry → empty.

## Non-goals

- No central snapshot content store. Full JSON never leaves the source repo.
- No networked sync. All data stays on the local filesystem.
- No change to the `.bookmark/` root name or the existing per-project layout semantics.

## Design

### 1. Snapshot ID and filename embed the project name

**Current:** `SNAP_20260414_222429.json`
**New:** `SNAP_20260414_222429__obsidian-vault.json`
         (ID: `SNAP_20260414_222429__obsidian-vault`)

Format: `SNAP_<YYYYMMDD>_<HHMMSS>__<project-slug>`

- Double underscore separates timestamp from slug — unambiguous split.
- `project-slug` = last path segment of `project_path`, lowercased, non-alnum → `-`,
  trimmed, capped at 40 chars. Collisions between same-name projects at different
  paths are disambiguated in the registry (see §2), not in the filename.
- Validation regex becomes `^SNAP_\d{8}_\d{6}(__[a-z0-9-]{1,40})?$`. The trailing
  group is optional to keep old IDs loadable.

**Why embed in the ID (not just the JSON body):** a snapshot file viewed in a file
manager, copied into a Slack message, or referenced in a memory pointer is
self-describing. You never need to open it to learn what project it belongs to.

### 2. Per-project storage (unchanged layout, new filenames)

```
<project>/.bookmark/
├── bookmark.context.md           ← session summary (unchanged)
├── snapshots/
│   └── SNAP_20260414_222429__obsidian-vault.json   ← name now carries project
├── index.json                    ← per-project (unchanged)
├── LATEST.md                     ← per-project (unchanged)
├── state.json                    ← per-project (unchanged)
└── trails/files.md               ← per-project (unchanged)
```

No new directories inside a project. The project name is carried by the snapshot's
ID, not the folder hierarchy.

### 3. Global registry at `~/.bookmark/registry.json`

A lightweight, cross-project index. Pointer data only — no snapshot content.

```json
{
  "version": "1.0.0",
  "last_updated": 1776230669940,
  "last_project": {
    "path": "/Users/tyroneross/Documents/Obsidian Vault",
    "name": "Obsidian Vault",
    "slug": "obsidian-vault",
    "last_snapshot_at": 1776230669940
  },
  "snapshots": [
    {
      "id": "SNAP_20260414_222429__obsidian-vault",
      "timestamp": 1776230669940,
      "trigger": "manual",
      "project_path": "/Users/tyroneross/Documents/Obsidian Vault",
      "project_name": "Obsidian Vault",
      "project_slug": "obsidian-vault",
      "canonical_file": "/Users/tyroneross/Documents/Obsidian Vault/.bookmark/snapshots/SNAP_20260414_222429__obsidian-vault.json",
      "files_changed_count": 20
    }
  ]
}
```

Rules:
- Written by `storeSnapshot` on every capture (append + dedupe by ID).
- Capped at 500 entries; oldest dropped on overflow.
- Stale entries (whose `canonical_file` is missing) pruned lazily on read.
- `last_project` is updated on every `restore` too — drives post-`/clear` fallback.
- Same-name projects at different paths get the same `slug` in the ID but distinct
  `project_path` in the registry. Lookup by ID + optional path disambiguator.

### 4. Separation: `~/.bookmark/` roles

The home directory accumulates three distinct things today, conflated. After this
change:

| Role | Location | Notes |
|---|---|---|
| Global registry | `~/.bookmark/registry.json` | new |
| Home-scope pointer | `~/.bookmark/bookmark.context.md` with `scope: home` | unchanged |
| Home-CWD snapshots | **no longer written** | see §5 |

**Home-CWD snapshot suppression:** when CWD resolves to `$HOME`, refuse to write
per-project snapshots into `~/.bookmark/snapshots/`. Emit a one-line stderr notice:
`bookmark: skipping snapshot — $HOME has no project scope. Run from a project dir
or set BOOKMARK_ALLOW_HOME=1 to override.` This removes the ambiguity where `~/`
behaves as both pointer host and real project.

Existing home-scope snapshot content stays on disk untouched — we only stop writing
new ones. A follow-up PR can archive or migrate the existing set.

### 5. Command fallback order

All read-side commands share this resolution chain:

```
1. Explicit --cwd / --project flag?           → use it directly
2. $CWD/.bookmark/ has useful data?           → use it
3. $CWD/.bookmark/bookmark.context.md is a
   home-scope pointer?                        → follow to canonical
4. Global registry has `last_project`?        → use that project's .bookmark/
5. Return empty, suggest /bookmark:list --all
```

Per-command behavior after the change:

- `bookmark list` — default lists current project. Add `--all` (cross-project via
  registry) and `--project <slug>` (pick a specific project).
- `bookmark show <id>` — if ID not found in CWD, query registry for its
  `canonical_file` and read from there. No CWD guessing.
- `bookmark show --latest` — follows the full chain; gets latest from wherever
  resolution lands.
- `bookmark status` — shows current-CWD stats by default, adds a footer line
  `Other projects with snapshots: N (use --all to list)`.
- `bookmark restore` — already follows home pointer; add step 4 so post-`/clear`
  from `~/` still finds the last-active project when no pointer exists.

### 6. Slash command updates

- `commands/restore.md` — swap `show --latest` for
  `restore --session-source clear`; already handles pointer + new registry fallback.
- `commands/list.md` — default unchanged; add hint line: "run with `--all` to see
  snapshots from other projects."
- `commands/snapshot.md` — no change to call; output now includes the project slug
  in the printed ID, so user/operator can trace it without extra tooling.
- `commands/status.md` — surface the "other projects" count.

## Implementation steps

Work in this order so each commit leaves the repo in a working state.

### Step 1 — ID + filename schema (backwards-compatible)

Files:
- `src/snapshot/capture.ts` — `generateSnapshotId(projectPath)` appends `__<slug>`.
- `src/snapshot/storage.ts` — `loadSnapshot` accepts both old and new ID shapes;
  validation regex widened. Remove the duplicate `generateSnapshotId()` (dead code).
- `src/types.ts` — add `project_slug?: string` to `Snapshot`.

Test: existing fixtures still load; new captures produce new-format IDs.

### Step 2 — Global registry

Files:
- `src/registry/index.ts` (new) — `appendToRegistry(entry)`, `findById(id)`,
  `findLastProject()`, `pruneStale()`, `listAll({limit, sinceDays})`.
- `src/snapshot/capture.ts` — call `appendToRegistry` after `storeSnapshot`.
- `src/restore/index.ts` — touch `last_project` on every successful restore.

Registry path: `~/.bookmark/registry.json`. Use a simple write-through (read, mutate,
write) — volumes are tiny (≤500 entries × small objects). Add lock-file safety
(`registry.json.lock`) to avoid concurrent-session corruption.

Test: two parallel captures across different projects both land in registry; one
deleted snapshot file is auto-pruned on next read.

### Step 3 — Fallback resolution

Files:
- `src/cli/index.ts` — new helper `resolveScope({cwd, explicitProject, id?})` returns
  `{storagePath, projectPath, source}`. Used by `list`, `show`, `status`, `restore`.
- Update each command action to use the resolver instead of calling
  `getStoragePath(cwd)` directly.

Test matrix:
- In project dir: unchanged behavior.
- In `~/` with home pointer → follows pointer.
- In `~/` with no pointer but `last_project` set → uses last project.
- `show SNAP_*__foo` from unrelated dir → registry resolves to `foo`'s dir.

### Step 4 — Home-CWD suppression

Files:
- `src/snapshot/capture.ts` — early return if `cwd === homedir()` and
  `process.env.BOOKMARK_ALLOW_HOME !== '1'`. Log to stderr; do not error.
- `src/cli/index.ts` — suppress the "Snapshot captured" success line when skipped.

Test: `cd ~ && npx bookmark snapshot --trigger manual` produces no file, no index
entry, one stderr line.

### Step 5 — Slash command edits

Files:
- `commands/restore.md` — call `bookmark restore --session-source clear`.
- `commands/list.md` — document `--all`, `--project`.
- `commands/status.md` — mention cross-project count footer.

### Step 6 — Migration

Files:
- `src/setup/auto-setup.ts` — `ensureProjectBootstrapped` now also:
  1. Migrates old-ID filenames to new format by **writing a registry entry only**
     (does not rename files — keeps old refs valid).
  2. Ensures `~/.bookmark/registry.json` exists on first run.

One-shot scan: on first launch after upgrade, walk `~/Desktop/git-folder/*/.bookmark/`
and `$HOME/.bookmark/` (lazy — only if they exist), index existing snapshots into
the registry. Cap walk at 2s.

## Schema changes summary

- `Snapshot.project_slug?: string` (new)
- `SnapshotIndex.project_slug?: string` (new)
- `~/.bookmark/registry.json` (new file)
- ID regex widened to accept optional `__<slug>` suffix
- `state.json`: add `home_cwd_skipped_count?: number` (observability)

## Risks / edge cases

- **Same slug, different projects:** e.g. two `api` dirs in different parents. Slug
  collisions are not unique IDs — registry disambiguates by `project_path`. `show`
  with an ambiguous lookup prints candidates and requires `--project-path` to
  resolve.
- **Registry corruption:** write-through with lockfile + schema-version check. On
  parse failure, back up the bad file and rebuild from walking known `.bookmark/`
  dirs.
- **User deletes a project dir:** registry prune marks entries as unreachable; kept
  for 30 days then dropped, so a restored backup still finds its snapshots.
- **Long project paths (symlinks, worktrees):** slug derived from `realpath(cwd)`'s
  last segment. Registry stores both `realpath` and `cwd`-as-seen for traceability.
- **`$HOME` is an actual active project:** unlikely; opt-in via
  `BOOKMARK_ALLOW_HOME=1`.

## Out of scope (follow-ups)

- UI/dashboard for cross-project browsing.
- Remote sync / team sharing of registry.
- Auto-archive of old snapshots into cold storage.
- Renaming existing on-disk snapshot files to new ID format (low value, high churn).

## Acceptance checklist

- [ ] New captures produce IDs of shape `SNAP_<ts>__<slug>`
- [ ] `~/.bookmark/registry.json` gains an entry per capture
- [ ] `show <ID>` from any CWD finds the file
- [ ] `list --all` shows snapshots across all tracked projects
- [ ] `/bookmark:restore` after `/clear` from `~/` resolves to last-active project
- [ ] No snapshot is written when CWD is `$HOME` (unless opt-in)
- [ ] Existing old-format snapshots still `show` and `list` correctly
- [ ] `~/.bookmark/bookmark.context.md` pointer still works unchanged
