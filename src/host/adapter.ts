import { statSync } from 'node:fs';
import {
  estimateContextUsageFromTurns,
  readGeminiContextUsage,
  readLatestContextUsage,
  type ContextUsageObservation,
} from '../threshold/token-usage.js';
import { loadAllManifests, loadManifest, type HostManifest, type OutputStyle, type Role } from './manifest.js';

/**
 * Host adapters translate between one host's hook dialect and Bookmark's
 * host-free core (docs/research/2026-10-28-multi-host-support.md §11). Every
 * host fact comes from `hosts/<id>.json`; this file holds behaviour only.
 */

export interface HookEvent {
  host: string;
  role: Role;
  sessionId?: string;
  cwd?: string;
  transcriptPath?: string;
  model?: string;
  prompt?: string;
  source?: string;
  stopHookActive?: boolean;
}

export type HookAction =
  | { kind: 'inject'; text: string; systemMessage?: string }
  | { kind: 'notify'; systemMessage: string }
  | { kind: 'block-stop'; reason: string; systemMessage?: string }
  | { kind: 'noop' };

export interface HostAdapter {
  id: string;
  manifest: HostManifest;
  capabilities: HostManifest['capabilities'];
  detect(stdin: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean;
  normalize(stdin: Record<string, unknown>, role: Role): HookEvent;
  readUsage(ev: HookEvent, options: { contextLimitOverride?: number; pendingPrompt?: string; env?: NodeJS.ProcessEnv; previousEstimatedTokens?: number }): ContextUsageObservation | null;
  emit(ev: HookEvent, action: HookAction): { stdout: string; exitCode: number };
}

function firstString(stdin: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stdin[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function firstBoolean(stdin: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof stdin[key] === 'boolean') return stdin[key] as boolean;
  }
  return undefined;
}

/**
 * Keep a transcript path only when it names a regular file (symlinks are
 * followed): a FIFO or device would block the hook's read forever.
 */
function regularFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    // A path that does not exist yet is kept; readers treat it as "no usage".
    return path;
  }
}

export function createAdapter(manifest: HostManifest): HostAdapter {
  const { fields, output, detect } = manifest;

  function styled(style: OutputStyle, event: string | undefined, text: string, systemMessage?: string): string {
    if (style === 'text') return text;
    const body: Record<string, unknown> = {};
    if (systemMessage && output.systemMessage) body.systemMessage = systemMessage;
    if (style === 'hookSpecificOutput') {
      body.hookSpecificOutput = { hookEventName: event, additionalContext: text };
    } else {
      body.additionalContext = text;
    }
    return JSON.stringify(body);
  }

  function noop(role: Role): string {
    if (role === 'restore' && output.restore === 'text') return '';
    return JSON.stringify(role === 'stop' ? output.noop.stop : output.noop.default);
  }

  return {
    id: manifest.id,
    manifest,
    capabilities: manifest.capabilities,

    detect(stdin, env) {
      const has = (key: string) => stdin[key] !== undefined && stdin[key] !== null;
      const eventName = typeof stdin.hook_event_name === 'string' ? stdin.hook_event_name : undefined;
      if (eventName && detect.events?.includes(eventName)) return true;
      const keyRules = Boolean(detect.anyKeys?.length || detect.allKeys?.length);
      if (keyRules) {
        const all = (detect.allKeys ?? []).every(has);
        const any = !detect.anyKeys?.length || detect.anyKeys.some(has);
        const none = !(detect.noneKeys ?? []).some(has);
        if (all && any && none) return true;
      }
      const transcriptPath = firstString(stdin, fields.transcriptPath);
      if (transcriptPath && detect.transcriptPathIncludes?.some(part => transcriptPath.includes(part))) return true;
      return Boolean(detect.env?.some(name => Boolean(env[name])));
    },

    normalize(stdin, role) {
      return {
        host: manifest.id,
        role,
        sessionId: firstString(stdin, fields.sessionId),
        cwd: firstString(stdin, fields.cwd),
        transcriptPath: regularFile(firstString(stdin, fields.transcriptPath)),
        model: firstString(stdin, fields.model),
        prompt: firstString(stdin, fields.prompt),
        source: firstString(stdin, fields.source),
        stopHookActive: firstBoolean(stdin, fields.stopHookActive),
      };
    },

    readUsage(ev, options) {
      if (!ev.transcriptPath) return null;
      const pendingPrompt = options.pendingPrompt ?? '';
      switch (manifest.usage) {
        case 'transcript-jsonl':
          return readLatestContextUsage(ev.transcriptPath, options.contextLimitOverride, pendingPrompt, ev.sessionId);
        case 'gemini-session':
          return readGeminiContextUsage(ev.transcriptPath, options.contextLimitOverride, pendingPrompt, ev.sessionId);
        case 'turn-estimate': {
          const perTurn = Number.parseInt((options.env ?? process.env).BOOKMARK_TOKENS_PER_TURN ?? '', 10);
          return estimateContextUsageFromTurns(ev.transcriptPath, {
            override: options.contextLimitOverride,
            model: ev.model,
            tokensPerTurn: Number.isFinite(perTurn) && perTurn > 0 ? perTurn : undefined,
            previousTokens: options.previousEstimatedTokens,
          });
        }
        default:
          return null;
      }
    },

    emit(ev, action) {
      const event = manifest.events[ev.role];
      switch (action.kind) {
        case 'noop':
          return { stdout: noop(ev.role), exitCode: 0 };
        case 'notify':
          if (output.systemMessage) return { stdout: JSON.stringify({ systemMessage: action.systemMessage }), exitCode: 0 };
          // No notice channel: at stop, one block whose reason asks the agent to relay the notice.
          if (ev.role === 'stop' && manifest.capabilities.blockStop) {
            return {
              stdout: JSON.stringify({
                decision: output.blockDecision,
                reason: `Tell the user this Bookmark notice in one sentence, then stop: ${action.systemMessage}`,
              }),
              exitCode: 0,
            };
          }
          return { stdout: noop(ev.role), exitCode: 0 };
        case 'inject': {
          // Degrade by capability: prompt-time injection the host ignores becomes a notice.
          if (ev.role === 'context-check' && !manifest.capabilities.injectOnPrompt) {
            return action.systemMessage && output.systemMessage
              ? { stdout: JSON.stringify({ systemMessage: action.systemMessage }), exitCode: 0 }
              : { stdout: noop(ev.role), exitCode: 0 };
          }
          const style = ev.role === 'restore' ? output.restore : output.inject;
          return { stdout: styled(style, event, action.text, action.systemMessage), exitCode: 0 };
        }
        case 'block-stop': {
          if (!manifest.capabilities.blockStop) return { stdout: noop(ev.role), exitCode: 0 };
          const body: Record<string, unknown> = { decision: output.blockDecision, reason: action.reason };
          if (action.systemMessage && output.systemMessage) body.systemMessage = action.systemMessage;
          return { stdout: JSON.stringify(body), exitCode: 0 };
        }
      }
    },
  };
}

export function getAdapter(id: string): HostAdapter | null {
  const manifest = loadManifest(id);
  return manifest ? createAdapter(manifest) : null;
}

/**
 * Pick the adapter for one hook call: an explicit `--host <id>` first; stdin
 * sniffing (manifest `detect` rules, by `detectPriority`) only as a fallback;
 * the manifest with an empty `detect` (Claude Code) last.
 */
export function resolveAdapter(
  stdin: Record<string, unknown> | null,
  explicitHost: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): { adapter: HostAdapter; warning?: string } {
  let warning: string | undefined;
  if (explicitHost) {
    const adapter = getAdapter(explicitHost);
    if (adapter) return { adapter };
    warning = `bookmark: unknown --host '${explicitHost}'; detecting the host from stdin instead`;
  }
  const manifests = loadAllManifests().sort((a, b) => a.detectPriority - b.detectPriority);
  const adapters = manifests.map(createAdapter);
  const fallback = adapters.find(adapter => Object.keys(adapter.manifest.detect).length === 0);
  const input = stdin ?? {};
  for (const adapter of adapters) {
    if (adapter === fallback) continue;
    if (adapter.detect(input, env)) return { adapter, warning };
  }
  if (!fallback) throw new Error('bookmark: no host manifest with an empty detect rule (hosts/claude.json missing)');
  return { adapter: fallback, warning };
}
