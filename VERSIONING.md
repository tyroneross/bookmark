# Bookmark — Versioning & Source of Truth

## Current

- **Version:** 0.3.2
- **Source of truth:** Local dev (`~/Desktop/git-folder/bookmark`)
- **Also available at:**
  - GitHub: https://github.com/tyroneross/bookmark
  - npm: `@tyroneross/bookmark`
  - Marketplace: `bookmark` in `RossLabs-AI-Toolkit` (via GitHub source)
- **Claude Code cache mirror (marketplace scope):** `~/.claude/plugins/cache/bookmark/bookmark/0.3.2/`

## Key changes in 0.3.2

- Stop and precompact hooks skip stdin reading — fixes JSON validation error
- Marketplace schema fields added (name, owner, plugins)
- Removed explicit path fields from plugin.json for auto-discovery
- Tag-triggered npm publish workflow

## Where to look for the latest version

| Source | Location | Notes |
|---|---|---|
| **Authoritative** | `~/Desktop/git-folder/bookmark/.claude-plugin/plugin.json` | Local dev — canonical |
| GitHub | github.com/tyroneross/bookmark | Public mirror |
| npm | `@tyroneross/bookmark` | Published releases (marketplace installs pull from here) |
| Marketplace manifest | `~/Desktop/git-folder/RossLabs-AI-Toolkit/.claude-plugin/marketplace.json` | Must be kept in sync with plugin.json version |
| Cache mirror | `~/.claude/plugins/cache/bookmark/bookmark/<version>/` | Marketplace-scope install only |

When "latest" is ambiguous, trust **local dev** first, then npm, then marketplace.json.

## Release discipline (enforce before committing a version bump)

1. Bump `version` in `.claude-plugin/plugin.json`
2. Update the version stamp in `CLAUDE.md` (line 1 HTML comment)
3. Update this file's `Current` section + add an entry to `Version history` below
4. **Update `~/Desktop/git-folder/RossLabs-AI-Toolkit/.claude-plugin/marketplace.json`** — bump the version string for the `bookmark` entry
5. Delete older cache entries (marketplace scope only): `rm -rf ~/.claude/plugins/cache/bookmark/bookmark/<old-version>/`
6. Back up, then update `~/.claude/plugins/installed_plugins.json` → `installPath` + `version` for every entry of this plugin
7. Run `/reload-plugins` in Claude Code
8. Commit `plugin.json`, `CLAUDE.md`, `VERSIONING.md` together in one commit; update the marketplace repo separately

**Never leave two cached versions side-by-side** — Claude Code's resolver is not guaranteed to pick the newest.

## Version history

- **0.3.2** (current): Stop/precompact stdin fix, marketplace schema conformance, auto-discovery of manifest fields
- Prior versions: Not tracked in this file; see `git log` for detail
