# Session rollover: retro → handoff → clear → deliver (research packet, 2026-09-05)

Status: research, no code. Decision owed by Tyrone on three points at the end.
Persona-lab run: `~/.persona-lab/encounters/pr-20260905-rollover-01/` (6 personas, blind, frozen at bookmark@a3b583f, build-loop@7765cfad).
Build-loop backlog filed: `BUIL-HANDOFF-m1t1qxxmb3w9rc40fz3ck` (handoff `--launch` documented, not implemented).

## 1. Verified platform facts (fetched 2026-09-05)

| Fact | Source | Status |
|---|---|---|
| Claude Code SessionStart matcher values: `startup`, `resume`, `clear`, `compact`, `fork` | code.claude.com/docs/en/hooks.md | ✅ fetched |
| SessionEnd fires on `/clear` with reason `clear` | same | ✅ fetched |
| SessionStart plain stdout on exit 0 is "added as context that Claude can see and act on"; JSON form `hookSpecificOutput.additionalContext` also accepted | same | ✅ fetched |
| No supported way for a skill, hook, CLI flag, or SDK to run `/clear` or `/compact` | same + cli-reference + skills docs | ✅ NOT FOUND after search |
| `claude "prompt"` prefills but does not submit; `--append-system-prompt-file` exists | cli-reference.md | ✅ relayed by claude-code-guide |
| Codex CLI 0.153.4 has lifecycle hooks: SessionStart/SessionEnd/PreCompact/Stop etc., `~/.codex/hooks.json`, `<repo>/.codex/hooks.json`, plugin `hooks/hooks.json`; SessionStart matcher `startup|resume|clear|compact`; returns `hookSpecificOutput.additionalContext` | learn.chatgpt.com/docs/hooks | ✅ fetched |
| Codex plain-stdout injection on SessionStart | not in docs | ❓ unverified — emit JSON, not bare text |
| Codex `/new`, `/clear`, `/compact` exist; no RPC; `codex exec` and app-server `thread/start` are fresh threads | learn.chatgpt.com/docs/cli/slash-commands | ✅ relayed |
| Gemini CLI SessionStart hook + additionalContext; OpenCode `session.created` plugin event | gemini-cli docs/hooks; opencode.ai/docs/plugins | ⚠️ relayed, not spot-checked |

## 2. Local state (bookmark@a3b583f, build-loop@7765cfad)

- bookmark restore already runs on `source: clear` and prints the handoff as plain stdout (`src/cli/index.ts:111-114`). Works on Claude Code by the stdout rule; will not work under Codex hooks (bare text, no JSON).
- bookmark Stop hook returns `decision: block` and asks Claude to write `bookmark.context.md` (`src/cli/index.ts:403-411`). A rollover skill that also writes that file has a competing writer.
- `bookmark.context.md` is budgeted at ~400 tokens and content under 200 chars is discarded for a fallback banner (`trails/reader.ts:6`, `restore/index.ts:161-166`). Fatal for a rich handoff, fine for a pointer stub.
- build-loop `scripts/handoff` composes a 9-section, cold-read-tested handoff with only stdlib; zero Claude-specific references. Portable.
- build-loop SessionEnd hook runs the deterministic retro sweep, nohup-detached, fail-open, no-ops under 8 tool uses. It fires on `/clear` (old session's transcript), so a retro at clear is already free, but silent when it fails.
- `rally run claude --name N --shared --task PROMPT` launches a managed tmux/ptyd session with an initial prompt. This machine's default terminal is Apple Terminal, no tmux.

## 3. Options for "clear, then deliver"

| # | Mechanism | Manual steps | Hosts | Named risk |
|---|---|---|---|---|
| A | Mailbox + SessionStart(clear) hook. Skill writes handoff + `armed` marker, user types `/clear`, hook injects | 1 keystroke | Claude, Codex, Gemini | user never clears; stale marker replays |
| B | A + auto-clear: Stop hook sees `armed` and `tmux send-keys -l '/clear'` then `Enter` | 0 | tmux/ptyd panes only | keystroke lands in wrong pane; race with queued input |
| C | New window: `rally run claude --shared --task "Read <handoff> and continue"` | 0, old window stays | anywhere rally is installed | two live sessions on one checkout; rally dependency |
| D | `osascript` opens Terminal.app running `claude --append-system-prompt-file <handoff>` | 0 | macOS only | brittle, not host-neutral |
| E | Skill kills its own process to force SessionEnd | 0 | any | hooks may not fire; data loss. Rejected |

## 4. My recommendation vs the persona panel

| Question | My v1 (frozen before reading panel) | Panel (6 personas) | Resolution |
|---|---|---|---|
| Automate `/clear`? | A default, B when `$TMUX_PANE` set | 5/6 manual; P2 automates with idle-poll | **Manual by default.** P6's framing wins: the keystroke is the confirmation step, the last moment the human can reject a bad card. B stays as opt-in `--auto-clear`. |
| Home | bookmark | 4 build-loop, 2 bookmark | **bookmark owns delivery, build-loop owns content.** Bookmark is the only plugin that runs in non-run sessions and already owns every boundary hook. build-loop stays one-router; its handoff script is the content provider. |
| Channel | full handoff into bookmark path | P5/P6: pointer stub in `bookmark.context.md`; P1/P3: separate baton with manifest | **Pointer stub + full doc at an absolute path in the stable checkout.** Stub carries nonce, path, task, first action, landmine. Respects the 400-token budget. |
| Retro timing | LLM retro if run active, else sweep | P1/P3 foreground (sweep silently no-ops); P5/P6 leave to sweep | **Run the deterministic retro synchronously inside the command; report its exit.** Sweep remains the fallback. LLM narration stays on-demand. |
| Verification | none | 5/6: nonce echo | **Adopt.** Fresh session's first line echoes `ROLLOVER_ID`; a receipt is written by the receiver, never the sender. |
| Failure posture | fail-open | P3: fail-loud at compose; fail-open at restore | **Adopt P3.** Compose fails loud (no clear until the baton exists); restore stays fail-open with a visible banner. |
| Codex | hook config adapter | P4 only; 4 cut it | **Keep, cheaply.** Emit the JSON `hookSpecificOutput` shape from one script; wire the same command in `.codex/hooks.json`. Plain stdout is unverified on Codex, so JSON is the portable form. |
| Competing writer | not considered | P1/P3: Stop-hook `decision: block` | **Must reconcile.** When `armed` exists, the Stop hook approves instead of demanding a rewrite. |

Where the panel changed my design: nonce verification, foreground retro, fail-loud compose, pointer stub instead of full doc in the bookmark channel, Stop-hook reconciliation. Where I held: bookmark as home, keep the Codex adapter.

## 5. Recommended design (v2)

One user-facing command in bookmark, `/bookmark rollover` (or `/bookmark:rollover`), reachable from build-loop by "hand off" routing.

1. **Retro**: `python3 -m retrospective` from build-loop, synchronous, exit code reported. Skipped only if build-loop is absent.
2. **Handoff**: if `.build-loop/` exists, `scripts/handoff --output <stable-checkout>/.bookmark/rollover/handoff-<ulid>.md`; else bookmark's existing handoff prompt. Write `armed.json` {id, ts, session_id, cwd, handoff_path, sha256}. Post `rally say fact` with the absolute path when rally is present.
3. **Stub**: write a 5-line pointer into `bookmark.context.md` (nonce, path, task, first action, landmine). Stop hook sees `armed.json` and approves rather than blocks.
4. **Clear**: print the 5-line preview and, as the last line on screen, `type /clear`. `--auto-clear` sends keys only when `$TMUX_PANE` is set. `--new-window` uses `rally run --shared --task`.
5. **Deliver**: SessionStart hook, matcher `clear|startup`, reads `armed.json`; if under 12h, same cwd, not consumed, emit `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<stub + first 400 tokens of handoff>"}}`, then mark consumed. Same script in `.codex/hooks.json`; `.gemini/settings.json` later.
6. **Verify**: instruct the fresh session to echo `ROLLOVER_ID` and write `RECEIPT.read`.

Estimated size: bookmark ~150 lines TS + hook wiring; build-loop: delete or implement `--launch` per the filed backlog item. No new repo.

## 6. Decisions owed

1. Accept one keystroke (`/clear`) as the default, with `--auto-clear` only under tmux?
2. Home in bookmark with build-loop as content provider (my call), or build-loop as the panel majority prefers?
3. Should the Stop hook stop demanding a handoff rewrite whenever `armed.json` is fresh?

## 7. Open, not yet measured

- Cold `npx @tyroneross/bookmark` latency vs the 5000ms SessionStart timeout (P2). A silent timeout is an empty restore after context is already gone.
- Whether two concurrent Codex sessions break `transcript_adapter` rollout selection (P4).
- Live nonce test on Codex hooks (JSON path) has not been run.
