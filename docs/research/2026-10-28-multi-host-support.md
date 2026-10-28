# Multi-host support for Bookmark — research (2026-10-28)

Scope: which agent hosts can run Bookmark's four hook roles (restore on session start, context-check on prompt
submit, precompact, stop-time handoff), where each host keeps its transcript, and how Bookmark can learn a model's
context window without a hard-coded table.

Confidence legend: ✅ official doc (T1) · ⚠️ secondary source or local observation only · ❓ not found.
"Local obs." = read-only inspection of files on this Mac on 2026-10-28 (one machine, one version; not a contract).
Most official pages carry no date or version; where none is shown the row says "undated, fetched 2026-10-28".

Bookmark roles used below: **R** restore (SessionStart) · **C** context-check (UserPromptSubmit) · **P** precompact ·
**S** stop handoff (turn end, can force one more turn) · **E** session end.

---

## Verdict summary

| Host | Verdict | Hook format vs Claude Code | Usage + window in transcript? |
|---|---|---|---|
| Claude Code / Agent SDK | Supported (today) | — | usage yes, window no (table) |
| OpenAI Codex CLI | Supported | Near-identical (same field names) | **Both** (`token_count.info.model_context_window`) |
| Gemini CLI | Supported | Same shape, different event names | usage per docs, window no |
| GitHub Copilot CLI | Supported (PascalCase = Claude-compat mode) | Claude-compatible mode exists | undocumented |
| Cursor (agent + CLI) | Partial (no prompt-time injection; usage only at preCompact) | Different names/fields | transcript: no usage; preCompact payload: **both** |
| Antigravity (App/CLI/IDE) | Partial (no prompt-submit, no compaction event) | camelCase, own schema | undocumented |
| OpenCode | Partial (TS plugin, not shell hooks) | Plugin API | usage + model per message (local DB); window via models.dev |
| Amp | Partial (TS plugin, no usage API) | Plugin API | no usage exposed |
| Cline | Partial (TS SDK plugins; legacy shell hooks unclear) | Plugin API | `usage` in runtime snapshot; window not documented |
| Roo Code | No hooks documented | — | ❓ |

---

## 1. OpenAI Codex CLI

Source: https://learn.chatgpt.com/docs/hooks (redirect target of https://developers.openai.com/codex/hooks), undated,
fetched 2026-10-28; page says it describes "release behavior". ✅

| Item | Finding |
|---|---|
| Enabled | On by default; disable with `[features] hooks = false` (`codex_hooks` = deprecated alias). Admin `requirements.toml` can force off. |
| Config | `~/.codex/hooks.json`, `~/.codex/config.toml` `[hooks]`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`. All layers merge. Repo layer loads only when `.codex/` is trusted. Non-managed hooks need one-time trust review via `/hooks`. |
| Plugins | Plugin hooks from `hooks/hooks.json` in plugin root (or `hooks` entry in `.codex-plugin/plugin.json`). Env: `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`. Enabling a plugin does not trust its hooks. |
| Events → roles | R `SessionStart` (`source`: startup/resume/clear/compact/fork) · C `UserPromptSubmit` (`turn_id`, `prompt`) · P `PreCompact` / `PostCompact` (`trigger` manual/auto) · S `Stop` (`turn_id`, `stop_hook_active`, `last_assistant_message`) · E `SessionEnd` (`reason`, currently always `other`; runs on close, archive/delete, or 30 min idle). Also `Interrupt`, `SubagentStart/Stop`, tool events. |
| Common stdin | `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name`, `model`; `turn_id` on turn-scoped events; `permission_mode` on most. |
| Output | Common: `continue`, `stopReason`, `systemMessage`, `suppressOutput` (parsed, not implemented). Block: `{"decision":"block","reason":...}` (UserPromptSubmit, Stop, SubagentStop, PostToolUse). Inject: `hookSpecificOutput.{hookEventName, additionalContext}` (SessionStart, UserPromptSubmit, …). |
| Exit codes | 0 = continue; plain stdout becomes developer context for SessionStart/UserPromptSubmit; **Stop requires JSON stdout** (plain text invalid). 2 = block, reason on stderr. |
| Stop semantics | Fires per turn. `decision:"block"` does not reject the turn; Codex continues and uses `reason` as a new continuation prompt. Any Stop hook returning `continue:false` overrides others. Same shape as Claude Code. |
| Transcript | Rollout JSONL `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (⚠️ local obs.). `event_msg` → `payload.type=="token_count"` → `info.last_token_usage{input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens}`, `info.total_token_usage`, **`info.model_context_window`** (observed 475000). Model in `turn_context.payload.model`. |

Bookmark impact: the existing Claude hook commands work nearly unchanged. Only the transcript parser and the
"Stop must emit JSON" rule differ.

## 2. Google Gemini CLI

Sources: https://geminicli.com/docs/hooks.md and https://geminicli.com/docs/hooks/reference.md (undated, fetched
2026-10-28) ✅; https://geminicli.com/docs/cli/session-management.md ✅.

| Item | Finding |
|---|---|
| Config | `hooks` key in `settings.json`: project `.gemini/settings.json` > user `~/.gemini/settings.json` > system `/etc/gemini-cli/settings.json` > extensions. Entry: `type:"command"`, `command`, optional `name`, `timeout` (ms, default 60000), `matcher`. `/hooks enable-all` etc. Whether a feature flag is still required: ❓ (third-party says experimental opt-in). |
| Events → roles | R `SessionStart` (`source` startup/resume/clear) · C `BeforeAgent` (`prompt`) · P `PreCompress` (`trigger`, advisory only) · S `AfterAgent` (`prompt`, `prompt_response`, `stop_hook_active`) · E `SessionEnd` (`reason` exit/clear/logout/prompt_input_exit/other). Also BeforeModel/AfterModel/BeforeToolSelection/BeforeTool/AfterTool/Notification. |
| Common stdin | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`. |
| Output | `decision` allow/deny (`block` = alias of deny), `reason`, `continue`, `stopReason`, `systemMessage`, `suppressOutput`, `hookSpecificOutput.additionalContext` (SessionStart: first history turn interactively, prepended to prompt non-interactively). Stdout must contain only the final JSON. |
| Exit codes | 0 = parse JSON; 2 = block, stderr is reason; other = warning, continue. |
| Stop semantics | `AfterAgent` fires when the agent loop ends (per turn). `decision:"deny"` rejects the response and sends `reason` as a new prompt (retry) — equivalent to Claude's Stop block. `continue:false` ends without retry. `hookSpecificOutput.clearContext:true` clears history. |
| Transcript | `~/.gemini/tmp/<project_hash>/chats/` ✅; docs say it records "Token usage statistics (input, output, cached, etc.)" but give no schema. Local obs.: files are `session-*.jsonl` (first line `{sessionId, projectHash, startTime, kind}`); sampled files had no `tokens` key ⚠️. Third-party parser notes cached tokens are included in `promptTokenCount` ⚠️. **No context window recorded.** |

## 3. GitHub Copilot CLI (and cloud agent)

Source: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference (undated, fetched
2026-10-28) ✅.

| Item | Finding |
|---|---|
| Config | JSON with `"version": 1`. Repo: `.github/hooks/*.json`, inline `hooks` in `.github/copilot/settings(.local).json`, **and `.claude/settings(.local).json`**. User: `~/.copilot/hooks/*.json` or `$COPILOT_HOME/hooks/`, inline in `~/.copilot/settings.json`. Plugins: `hooks.json` / `hooks/hooks.json`. Policy dirs. Cloud agent reads only `.github/hooks/*.json`. Handler: `type:"command"`, `bash`/`powershell`, `cwd`, `env`, `timeoutSec` (default 30). |
| Claude compat | PascalCase event names (`SessionStart`, …) switch payloads to snake_case (`session_id`, …) + ISO timestamps, matching VS Code Copilot format. |
| Events → roles | R `sessionStart` (`source` startup/resume/new, `initialPrompt?`; output `additionalContext`) · C `userPromptSubmitted` (`prompt`; output `modifiedPrompt`, honored only by SDK hooks — **cannot inject context**) · P `preCompact` (`transcriptPath`, `trigger`, `customInstructions`; notification only) · S `agentStop` (`transcriptPath`, `stopReason`, `stop_hook_active`; `decision:"block"` + `reason` forces another turn; runaway guard after 8 consecutive blocks) · E `sessionEnd` (`reason`). |
| Common stdin | camelCase `sessionId`, `timestamp`, `cwd`; `transcriptPath` only on agentStop/subagent*/preCompact. |
| Exit codes | 0 parse JSON; 2 = warning by default (deny only for preToolUse/permissionRequest); other = fail-open. |
| Transcript | Not documented by GitHub. Third-party: `~/.copilot/session-state/<session-id>/events.jsonl`, format "undocumented" ⚠️; Copilot SDK lists `session.usage_info` and `assistant.usage` events ⚠️. Not present on this Mac. |

Bookmark impact: C must move to `agentStop` (measure at turn end) or `postToolUse.additionalContext`.

## 4. Cursor (IDE agent; CLI coverage unclear)

Source: https://cursor.com/docs/hooks (undated, fetched 2026-10-28) ✅. Forum reports (⚠️ T4): cloud agents skip
`stop`/`afterAgentResponse` (and possibly `sessionStart`, `beforeSubmitPrompt`); `beforeSubmitPrompt.updated_input`
stripped in v3.2.7.

| Item | Finding |
|---|---|
| Config | `hooks.json` with `"version": 1`: enterprise (`/Library/Application Support/Cursor/hooks.json`, `/etc/cursor/hooks.json`), team (dashboard), project `<root>/.cursor/hooks.json`, user `~/.cursor/hooks.json`. |
| Events → roles | R `sessionStart` (`session_id`, `is_background_agent`, `composer_mode`; output `additional_context`, `env`; fire-and-forget) · C `beforeSubmitPrompt` (`prompt`, `attachments`; output only `continue`, `user_message` — **no context injection**) · P `preCompact` (observational; input **`context_usage_percent`, `context_tokens`, `context_window_size`**, `message_count`, `messages_to_compact`, `is_first_compaction`, `trigger`) · S `stop` (`status` completed/aborted/error, `loop_count`; output `followup_message` auto-submitted as next user message; `loop_limit` default 5) · E `sessionEnd` (`reason`, `duration_ms`, `final_status`). |
| Common stdin | `conversation_id`, `generation_id`, `model`, `model_id?`, `hook_event_name`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path` (null if transcripts disabled; also env `CURSOR_TRANSCRIPT_PATH`). |
| Exit codes | 0 use JSON; 2 = deny; other = fail-open unless `failClosed:true`. |
| CLI | Doc only says `workspaceOpen` runs in desktop app and CLI; general CLI hook support ❓. |
| Transcript | Format not documented. Local obs.: `~/.cursor/projects/agent-transcripts/<id>/<id>.jsonl`, records `{role, message:{content}}` — **no usage, no model** ⚠️. |

Bookmark impact: only `preCompact` gives a usage number, and that arrives at compaction time — too late for a 75%
early warning. The stop hook can still ask for a handoff each N turns, or once per session.

## 5. Antigravity (App, CLI, IDE)

Source: https://antigravity.google/docs/hooks?tab=cli (page label "Hooks2-0", undated, fetched 2026-10-28) ✅.
Forum thread (⚠️ T4) questions whether IDE actually runs plugin hooks; changelog fixes are CLI-only.

| Item | Finding |
|---|---|
| Config | `.agents/hooks.json` (workspace), `~/.gemini/config/hooks.json` (global); CLI also loads plugin `hooks.json`. Handler: `type:"command"`, `command`, `timeout` (s, default 30), `enabled`. |
| Events → roles | R `SessionStart` (before first model call; output `injectSteps` of `systemMessage`/`userMessage`/`ephemeralMessage`/`toolCall`) · C none — nearest is `PreInvocation` (before **each model call**; `invocationNum`, `initialNumSteps`; can `injectSteps`) · P none · S `Stop` (`executionNum`, `terminationReason`, `error`, `fullyIdle`; output `decision:"continue"` keeps running, `reason` injected as system message) · E none. `PostInvocation` can `force_continue`/`terminate`. |
| Common stdin | camelCase `conversationId`, `workspacePaths` (no `cwd`), `transcriptPath`, `artifactDirectoryPath`, `modelName`. |
| Exit codes | ❓ not documented. |
| Transcript | `transcriptPath` provided; format ❓. Rules alternative: `AGENTS.md`, `.agents/rules/`, `~/.gemini/GEMINI.md` (⚠️ secondary). |

## 6. OpenCode

Source: https://opencode.ai/docs/plugins/ ("Last updated: Oct 27, 2026") ✅.

| Item | Finding |
|---|---|
| Mechanism | TS/JS plugins (Bun), not shell hooks. `.opencode/plugins/`, `~/.config/opencode/plugins/`, or npm names in `opencode.json` `"plugin"`. Signature `async ({project, client, $, directory, worktree}) => hooks`. |
| Events → roles | R `session.created` event · C none documented (`chat.message` not on page ❓) · P `experimental.session.compacting` hook (push to `output.context` or replace `output.prompt`) + `session.compacted` event · S `session.idle` event (notification; no documented "continue" return) · E `session.deleted`. |
| Inject | Documented only for compaction. `client` is an SDK client; prompting a session via SDK not documented on this page ❓. |
| Transcript | Local obs. ⚠️: SQLite `~/.local/share/opencode/opencode.db`, table `message`, JSON `data` has `tokens{input,output,reasoning,cache{read,write}}`, `modelID`, `providerID`. Context window not stored; OpenCode's model catalog is models.dev (TAG:INFERRED — same team; not confirmed in docs). |

## 7. Amp

Source: https://ampcode.com/docs/plugin-api (undated, fetched 2026-10-28) ✅; https://ampcode.com/manual (index only).

| Item | Finding |
|---|---|
| Mechanism | TS plugins run by Bun: `.amp/plugins/`, `~/.config/amp/plugins/`. Default-exported function receiving `PluginAPI`. Some APIs under `experimental` ("not stable"). |
| Events → roles | R `session.start` (`thread.id`) · C `agent.start` (turn start; can return `message:{content, display}` to add to the turn) · P none (agents can set `compactionThresholdTokens`, default 90%) · S `agent.end` (can return `action:'continue'` + `userMessage`) · E none. Others: `tool.call`, `tool.result`, `changes.prompt`. |
| Usage | No token-usage or context-window API in the event map. |
| Transcript | Threads ("save and share"); local storage path/format ❓. AGENTS.md supported (manual index). |

Bookmark impact: can restore and request handoffs, but cannot measure usage — would need a turn-count or
message-size heuristic.

## 8. Cline / Roo Code

- **Cline**: https://docs.cline.bot/features/hooks/hook-reference and /customization/hooks now redirect to
  https://docs.cline.bot/sdk/plugins.md (undated) ✅. Current model: TS `AgentPlugin` modules via `pluginPaths`;
  hooks `beforeRun` (can return `appendContext`), `afterRun`, `beforeModel`, `afterModel`, `beforeTool`, `afterTool`,
  `onEvent`; `setup(api, ctx)` at session start, `ctx.onDispose` at end; `ctx.emitEvent` (e.g. `steer_message`);
  runtime `snapshot` includes `usage`; context window not documented; compaction not covered. Legacy shell hooks
  (TaskStart, UserPromptSubmit, PreCompact with `estimatedTokens`, TaskComplete; dirs `~/Documents/Cline/Hooks/`,
  `.clinerules/hooks/`) appear only in mirrors/blog (⚠️) — status ❓. Verdict: partial, via TS plugin.
- **Roo Code**: no hook/lifecycle docs found ❓. Nearest: rules files and MCP (Bookmark already ships an MCP server
  under `src/mcp/`). Skip until docs exist.

## 9. Claude Agent SDK

Source: https://code.claude.com/docs/en/agent-sdk/hooks (undated, fetched 2026-10-28) ✅.

- In-process callbacks in `options.hooks`, plus shell hooks from settings files when `settingSources` /
  `setting_sources` includes them (on by default for `query()`).
- `SessionStart`/`SessionEnd` callbacks are TypeScript-only; Python gets them only as settings-file shell hooks.
  `UserPromptSubmit`, `Stop`, `PreCompact` exist in both; `PostCompact` TS-only.
- Inputs share `session_id`, `cwd`, `hook_event_name`; output format identical to Claude Code shell hooks.
- Verdict: supported for free when the embedding app loads project/user settings; otherwise Bookmark would need a
  small exported callback adapter. Transcript location for SDK sessions not stated on this page ❓.

---

## 10. Context-window sizes without a hard-coded table

| Source | Field | Auth | Notes |
|---|---|---|---|
| Codex rollout | `token_count.info.model_context_window` | none | Per-turn, authoritative for the running session. ⚠️ local obs. |
| Cursor `preCompact` payload | `context_window_size`, `context_usage_percent` | none | ✅ doc; only at compaction time. |
| Anthropic `GET /v1/models` | `max_input_tokens` ("Maximum input context window size in tokens"), `max_tokens` | API key | ✅ https://platform.claude.com/docs/en/api/models/list (example uses `anthropic-version: 2026-10-21`). |
| Gemini `models.get` / `models.list` | `inputTokenLimit`, `outputTokenLimit` | API key | ✅ https://ai.google.dev/api/models (last updated 2026-10-26). |
| OpenAI `GET /v1/models` | none — `id`, `created`, `object`, `owned_by`, `shutdown_date` only | — | ✅ https://developers.openai.com/api/reference/resources/models/methods/list. No context field. |
| OpenRouter `GET /api/v1/models` | `context_length`, `top_provider.context_length`, `top_provider.max_completion_tokens` | bearer key per spec | ✅ https://openrouter.ai/docs/api/api-reference/models/get-models. |
| models.dev `https://models.dev/api.json` | per provider→model `limit.context`, `limit.output` | none | ⚠️ community catalog (3800+ models per one consumer); used by third-party SDKs as authoritative for compaction thresholds. |

Bookmark runs inside hooks without API keys, so the resolution order should be:
1. `BOOKMARK_CONTEXT_LIMIT` override.
2. Window reported in the transcript or hook payload (Codex, Cursor preCompact).
3. Cached catalog lookup (models.dev `api.json`, refreshed at most daily off the hot path, e.g. during `restore`;
   stale cache allowed). Provider APIs only when a key is already in the environment, never prompted for.
4. Built-in table as offline fallback (current Claude regexes).
5. Unknown → keep today's `unknown_context_limit` status and ask once for a limit; never guess.

---

## 11. Recommended design: one neutral host adapter

```ts
type HostId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'antigravity' | 'opencode' | 'amp' | 'cline';
type Role = 'restore' | 'context-check' | 'precompact' | 'stop' | 'session-end';

interface HookEvent {          // normalized from host stdin
  host: HostId; role: Role;
  sessionId: string; cwd: string;
  transcriptPath?: string;
  model?: string;
  prompt?: string;             // context-check
  stopHookActive?: boolean;    // stop re-entry guard
  reportedUsage?: { usedTokens: number; windowTokens?: number }; // e.g. Cursor preCompact
}

interface HostAdapter {
  id: HostId;
  detect(stdin: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean;
  normalize(stdin: Record<string, unknown>, argvRole: Role): HookEvent;
  readUsage(ev: HookEvent): ContextUsageObservation | null;   // transcript parser per host
  emit(ev: HookEvent, action:
    | { kind: 'inject'; text: string }
    | { kind: 'block-stop'; reason: string }
    | { kind: 'noop' }): { stdout: string; exitCode: number };
  capabilities: { injectOnPrompt: boolean; blockStop: boolean; usageInTranscript: boolean; windowInTranscript: boolean };
}
```

Rules:
- **Detect explicitly first**: each host's install writes `bookmark <role> --host <id>`; stdin sniffing
  (`turn_id` → codex, `conversation_id`+`cursor_version` → cursor, `conversationId`+`workspacePaths` → antigravity,
  `sessionId` camelCase → copilot, `timestamp`+`session_id` w/o `turn_id` → gemini) is the fallback only. Plugin env
  vars (`CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, `CURSOR_TRANSCRIPT_PATH`) break ties.
- **Core stays host-free**: thresholds, state, handoff files, restore content are unchanged; adapters only translate.
- **Degrade by capability**: if `injectOnPrompt` is false (Cursor, Copilot), run context-check at stop instead; if no
  usage at all (Amp, Cursor transcripts), fall back to a turn-count heuristic and label it estimated.
- **Plugin hosts** (OpenCode, Amp, Cline) get a ~50-line TS shim that spawns the same `bookmark <role> --host <id>`
  CLI with a synthesized stdin, so logic stays in one place.
- **One neutral manifest** (`hosts/<id>.json`: events map, config path, output dialect) generates every host's
  hooks file, matching the "one neutral source → per-host formats" rule.

## 12. Priority (effort vs value)

| # | Host | Effort | Value | Why |
|---|---|---|---|---|
| 1 | Codex CLI | Low (in progress) | High | Same hook dialect as Claude; transcript carries usage **and** window. |
| 2 | Gemini CLI | Low–Med | High | Full role coverage incl. retry on AfterAgent; needs Gemini token parser + window from catalog. |
| 3 | Copilot CLI | Low | Med–High | Reads `.claude/settings.json` hooks and has a Claude-compat PascalCase mode; agentStop blocks. Gap: no prompt-time injection, transcript format undocumented. |
| 4 | Cursor | Med | Med | Large user base; stop `followup_message` + sessionStart work; usage only at preCompact. |
| 5 | Antigravity | Med | Med | Stop continue + SessionStart inject; no compaction/prompt event; exit codes and transcript format undocumented. |
| 6 | OpenCode | Med | Med | TS shim; good usage data in SQLite; window via models.dev. |
| 7 | Amp, Cline | Med–High | Low–Med | TS plugins, no/partial usage, API marked experimental/unstable. |
| — | Roo Code | — | — | Nothing documented; rules + MCP only. |

## Open questions (what would close them)
- Gemini session token schema: inspect a session file from a run with real model calls (sampled local files lacked `tokens`).
- Copilot `events.jsonl` usage events: capture one CLI session; confirm `assistant.usage` / `session.usage_info` on disk.
- Cursor CLI (`cursor-agent`) hook coverage: run a stub hook under the CLI.
- Antigravity exit-code semantics and transcript format: run a stub hook in the CLI.
- Agent SDK transcript path for embedded sessions.
