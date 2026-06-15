# Bookmark 2026 Context-Continuity Refresh

> Status: Draft assessment. Not yet executed.
> Date: 2026-06-15
> Target release: v0.5.0 or v0.6.0, depending on scope.

## Answer

Bookmark should not position itself as "compaction insurance" anymore. The
stronger role is a durable, repo-scoped session handoff layer: it records the
small set of state that must survive compaction, `/clear`, terminal restarts,
project switches, long async runs, and handoffs between agents.

The highest-value update is not a bigger extractor. It is tightening the
handoff contract:

1. The LLM-written `bookmark.context.md` must match the repo's own durability
   rules every time Stop or PreCompact asks for it.
2. The public docs must stop claiming regex extraction of decisions and open
   items. Source now correctly treats semantic continuity as an LLM-written
   artifact, plus mechanical file/tool trails.
3. The plugin surface needs a 2026 pass: skill-first packaging, Codex manifest
   completeness, token-budget cleanup, and hook compatibility with newer Claude
   Code lifecycle events.

## Current Repo Facts

- `src/snapshot/capture.ts` captures file changes and tool usage only. It
  explicitly does not extract intent, decisions, progress, or open items.
- `src/cli/index.ts` Stop and PreCompact currently ask Claude to write a short
  summary, but they do not require the identity block, `## Next steps`,
  `## Sources of truth`, absolute paths, or no-relative-time rules used by
  `/bookmark:verify`.
- `src/restore/index.ts` already has the right strategic guardrails:
  repo identity validation, home-scope pointer following, soft warning after
  24 hours, and hard block at 72 hours.
- `commands/*.md` are still the flat command format. Claude Code still supports
  this, but current docs recommend `skills/` for new plugin work.
- `skills/context-continuity/SKILL.md` is useful, but its frontmatter has a
  non-standard `version` key for Codex and the skill still describes snapshot
  restore as semantic context restore.
- `.codex-plugin/plugin.json` exists, but plugin-eval reports missing
  `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`, and `defaultPrompt`.
- The package validates for Claude Code and npm packaging:
  `claude plugin validate .`, `npm pack --dry-run --json`, and `npm test`
  all passed on 2026-06-15.

## Current External Signals

Source quality labels:

- T1: official Claude Code / Claude Platform docs and changelog.
- T2: Anthropic engineering or product posts.
- T3: community posts used only as ecosystem sentiment.

Signals:

- Claude Code plugins are now the distribution unit for skills, agents, hooks,
  MCP servers, LSP servers, monitors, default settings, and binaries. Official
  plugin docs also say commands are supported, but `skills/` are preferred for
  new plugins.
  Source: https://code.claude.com/docs/en/plugins
- Claude Code best practices emphasize context management, `/clear`, native
  compaction, `/compact <instructions>`, checkpoint rewind, subagents for
  investigation, and resume/named sessions.
  Source: https://code.claude.com/docs/en/best-practices
- The 2026-06-10 Claude Code changelog added nested subagents up to five levels,
  plugin marketplace search, long-conversation performance fixes, and a fix
  where sessions using 1M context without credits now auto-compact back under
  the standard limit.
  Source: https://code.claude.com/docs/en/changelog
- The Claude Platform context-window docs still recommend compaction for
  long-running conversations and point multi-session agents toward deliberate
  state artifacts.
  Source: https://platform.claude.com/docs/en/build-with-claude/context-windows
- The memory-tool docs frame durable memory as just-in-time retrieval, not
  loading everything into the context window. They also call out size limits,
  expiration, path traversal protection, and a multi-session development pattern
  with progress logs and end-of-session updates.
  Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Anthropic's context-engineering post says bigger context windows do not remove
  context pollution, attention-budget, and long-horizon coherence problems.
  It recommends compaction, structured note-taking, and multi-agent
  architectures for long-horizon work.
  Source: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Opus 4.8 and dynamic workflows increase pressure on Bookmark: large tasks now
  use hundreds of subagents plus verification. Bookmark has to help with the
  human-readable state boundary around that work, not compete with it.
  Source: https://www.anthropic.com/news/claude-opus-4-8
- Community posts from May-June 2026 converge on the same packaging mental
  model: skills are the lightest portable unit, plugins package several
  surfaces, hooks are deterministic and security-sensitive, and large contexts
  still benefit from capping/curation.
  Example sources:
  https://nimbalyst.com/blog/claude-code-plugins-guide/
  https://hidekazu-konishi.com/entry/claude_code_plugins_complete_guide.html
  https://blog.marcolancini.it/2026/blog-my-claude-code-setup/

## What Makes Bookmark Irrelevant

Bookmark becomes irrelevant if all five of these become true in the host:

1. Native resume is structured, repo-scoped, searchable, and survives project
   switches without the user remembering which session to resume.
2. Native memory is durable, path-validated, stale-aware, and small enough to be
   trusted as a startup artifact.
3. 1M+ context windows are cheap, fast, and maintain reliable attention over
   early decisions, tool results, and branch-specific state.
4. Native compaction preserves exact next steps, files, decisions, tests, and
   blockers with high recall and no stale-context failure mode.
5. Team/plugin workflows can export and review the same handoff artifact across
   Claude Code, Codex, CI/self-hosted runners, and human maintainers.

As of 2026-06-15, those conditions are not met. Long context is useful, but the
external guidance still treats context as finite and failure-prone. Bookmark
remains relevant if it is narrow: trusted handoff state, not another memory dump.

## Persona Review

### Infrequent compactor

This user rarely needs automatic snapshots. The plugin should default to low
noise and make its value explicit: "Use when changing tasks, stopping, clearing,
or resuming after time away." Do not sell aggressive interval snapshots as the
core experience.

### Power user with 1M context

This user may cap context early for coherence or use `/clear` often. Bookmark
should support clean-session workflows: write a durable handoff, clear context,
start fresh, restore only the summary and file trail.

### Team lead

This user cares about shared handoffs and onboarding. Bookmark should produce a
reviewable Markdown artifact with sources of truth, next steps, and validation,
not private transcript-derived guesses.

### Plugin maintainer

This user cares about install trust and update paths. Bookmark needs complete
Claude and Codex metadata, minimal always-on text, package payload audits, and a
clear compatibility matrix.

### Security reviewer

This user focuses on hooks and local file access. Bookmark should keep hooks
simple, make path validation explicit, avoid shell expansion assumptions, use
project-local `.bookmark/`, and document what code executes at each lifecycle
event.

### Multi-agent operator

This user may run subagents, dynamic workflows, or background sessions. Bookmark
should capture lead-level state and artifacts, not every subagent detail. The
snapshot analyst agent can become a review/synthesis helper for comparing
state across runs.

### Codex user

This user needs the plugin to look credible in Codex as well as Claude Code.
The current `.codex-plugin/plugin.json` is functional but under-described.
The Codex surface should include a default prompt and policy URLs, and the
context-continuity skill should use standard frontmatter.

## Prioritized Update Backlog

### P0 - Align handoff prompts with durability rules

Files:

- `src/cli/index.ts`
- `commands/snapshot.md`
- `commands/verify.md`
- `CLAUDE.md`
- `AGENTS.md`

Update Stop, PreCompact, and manual snapshot prompts to require:

- `BOOKMARK_IDENTITY` at the top of `bookmark.context.md`
- absolute paths only
- `## Current task`
- `## Progress`
- `## Decisions`
- `## Files changed`
- `## Sources of truth`
- `## Next steps`
- no relative time references

Add a short example template. Keep the output compact, but make it pass
`/bookmark:verify`.

### P0 - Fix public docs to match current behavior

Files:

- `README.md`
- `skills/context-continuity/SKILL.md`
- `src/mcp/tools.ts`
- command descriptions under `commands/`

Remove or rewrite claims that snapshots extract decisions, status, unknowns,
open items, errors, or sentiment from transcripts. The honest model is:

- `bookmark.context.md` is the semantic handoff, written by the agent.
- JSON snapshots are mechanical evidence: file changes and tool counts.
- `LATEST.md` is a file-trail fallback, not the primary continuity artifact.

Also fix stale README items:

- Node requirement: package says Node >=20, README says >=15.
- License: package says Apache-2.0, README says MIT.
- Smart mode: README references `--smart` and `BOOKMARK_SMART`, but current CLI
  does not implement smart extraction.
- Storage tree: update to include `bookmark.context.md`, `trails/`, and current
  archive/index behavior.
- Adaptive thresholds: clarify that actual token-level thresholding is no
  longer available; current automatic captures are time-based plus lifecycle
  hooks.

### P1 - Modernize plugin surfaces

Files:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `skills/context-continuity/SKILL.md`
- new `PRIVACY.md` and `TERMS.md` if publishing through Codex-facing surfaces

Actions:

- Add Codex `interface.defaultPrompt`, `websiteURL`, `privacyPolicyURL`, and
  `termsOfServiceURL`.
- Remove non-standard `version` from skill frontmatter or move it into the body.
- Decide whether to add skill equivalents for the legacy flat commands. Keep the
  current `commands/` for compatibility, but new user-facing workflows should
  be skill-first.
- Re-run `claude plugin validate .`, plugin-eval, `npm pack --dry-run --json`,
  and `npm test`.

### P1 - Hook compatibility and lifecycle review

Files:

- `hooks/hooks.json`
- `src/cli/index.ts`
- `src/setup/configure-hooks.ts`
- tests around hook input parsing

Actions:

- Revisit the current comments saying command hooks do not pipe stdin. Current
  official docs say command hook input arrives on stdin. Make Stop and
  PreCompact robust to both stdin and env-only execution.
- Evaluate adding `PostCompact` to verify the handoff exists after compaction.
- Evaluate adding `SessionEnd` for best-effort mechanical snapshot capture where
  supported, while keeping Stop as the only hook that can ask the model to write
  the semantic artifact.
- Make `/hooks` inspection part of release verification documentation.

### P1 - Positioning: "low-noise handoff", not "always-on memory"

Files:

- `README.md`
- marketplace descriptions
- command and skill descriptions

Messaging:

- Good: "durable repo-scoped handoff across clear, compaction, terminal close,
  and project switches."
- Good: "injects only the small current handoff plus file trail."
- Bad: "Claude never forgets everything."
- Bad: "zero context tax." There is still SessionStart injection, and Claude
  Code now reports plugin token costs.
- Bad: "install it and forget it." The core artifact is agent-written and should
  be verified.

### P2 - Add representative evals

Files:

- `tests/`
- possibly `evals/` or `fixtures/`

Scenarios:

- Stop hook asks for a summary; generated template passes verifier.
- PreCompact prompt includes identity and sources.
- Restore blocks stale context at >=72h.
- Restore follows a home-scope pointer.
- Path mismatch warning is surfaced.
- README examples match actual CLI output.
- Plugin-eval no longer reports missing Codex manifest fields.

### P2 - Snapshot analyst agent refresh

Files:

- `agents/snapshot-analyst.md`
- possibly new references under `skills/context-continuity/references/`

Update the agent to analyze:

- `bookmark.context.md` quality and verifier readiness
- file trail changes from `LATEST.md` and JSON snapshots
- timeline consistency between semantic handoff and mechanical file evidence

Do not ask the agent to infer decisions from raw transcript regex snapshots.

### P3 - Optional: memory-tool-aligned API shape

This is optional and should not lead. If implemented, keep it lightweight:

- expose a clear directory listing of `.bookmark/`
- return line-numbered file content for `bookmark.context.md`
- add size limits and pagination for historical snapshots
- never allow path traversal outside the project `.bookmark/`

The goal would be compatibility with just-in-time retrieval patterns, not a new
state store.

## What Not To Build

- Do not resurrect regex-based semantic extraction. The source already records
  why it failed: noisy decisions/open items are worse than no semantic record.
- Do not inject full snapshot history at SessionStart. That fights the current
  context-engineering guidance.
- Do not compete with native `/resume`, checkpoints, or dynamic workflows. Use
  Bookmark to summarize the stable boundary around them.
- Do not add heavy external dependencies. The current Node/TypeScript package is
  small and should stay easy to audit.
- Do not write runtime state into `.claude/`; project runtime data belongs in
  `.bookmark/`.

## First Implementation Slice

Smallest useful implementation:

1. Update Stop/PreCompact/manual snapshot prompts to generate verifier-ready
   `bookmark.context.md`.
2. Update README and MCP/skill descriptions to match the file/tool-only
   snapshot model.
3. Add Codex manifest missing fields and remove non-standard skill frontmatter.
4. Run:

```bash
claude plugin validate .
node /Users/tyroneross/.codex/plugins/cache/openai-curated/plugin-eval/c6ea566d/scripts/plugin-eval.js analyze . --format markdown
npm pack --dry-run --json
npm test
```

Expected outcome: no behavior regression, more accurate docs, lower trust risk,
and a primary handoff artifact that is more likely to survive a cold restart.

