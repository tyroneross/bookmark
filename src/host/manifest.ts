import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Host facts live in one place: `hosts/<id>.json` at the package root. This
 * module only loads and type-checks them; no host event names, config paths or
 * output dialects are written in TypeScript.
 */

export type Role = 'restore' | 'context-check' | 'precompact' | 'stop';
export const ROLES: readonly Role[] = ['restore', 'context-check', 'precompact', 'stop'];

/** How restore/inject text is written to stdout. */
export type OutputStyle = 'text' | 'hookSpecificOutput' | 'additionalContext';
/** Which transcript reader measures usage for this host. */
export type UsageReader = 'transcript-jsonl' | 'gemini-session' | 'turn-estimate';

export interface HostManifest {
  id: string;
  name: string;
  agentName: string;
  newSessionHint: string;
  source: string;
  /** Lower runs first during stdin sniffing; the host with an empty `detect` is the fallback. */
  detectPriority: number;
  detect: {
    /** stdin `hook_event_name` values only this host uses (e.g. Gemini's BeforeAgent). */
    events?: string[];
    anyKeys?: string[];
    allKeys?: string[];
    noneKeys?: string[];
    transcriptPathIncludes?: string[];
    env?: string[];
  };
  config: {
    /** `~/` expands to the current user's home directory. */
    path: string;
    /** grouped: hooks[event] = [{matcher?, hooks: [handler]}]; flat: hooks[event] = [handler]. */
    layout: 'grouped' | 'flat';
    matcher: string | null;
    fileVersion: number | null;
    commandKey: string;
    timeoutKey: string | null;
    timeouts: Partial<Record<Role, number>> | null;
  };
  /** Role → host event name. A role absent here is not installed for this host. */
  events: Partial<Record<Role, string>>;
  /** Normalized field → candidate stdin keys, first present wins. */
  fields: Record<'sessionId' | 'transcriptPath' | 'cwd' | 'model' | 'prompt' | 'source' | 'stopHookActive', string[]>;
  output: {
    restore: OutputStyle;
    inject: OutputStyle;
    blockDecision: string;
    systemMessage: boolean;
    noop: { stop: Record<string, unknown>; default: Record<string, unknown> };
  };
  usage: UsageReader;
  /** Unverified dialect details `bookmark install` prints for this host. */
  caveats?: string[];
  capabilities: {
    injectOnPrompt: boolean;
    blockStop: boolean;
    usageInTranscript: boolean;
    windowInTranscript: boolean;
  };
}

/** `hosts/` beside `dist/` (built) or `src/` (tests). */
export function hostsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', '..', 'hosts'), join(here, '..', '..', '..', 'hosts')];
  return candidates.find(dir => existsSync(dir)) ?? candidates[0];
}

const cache = new Map<string, HostManifest>();

export function listHostIds(dir: string = hostsDir()): string[] {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

export function loadManifest(id: string, dir: string = hostsDir()): HostManifest | null {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return null;
  const key = `${dir}:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as HostManifest;
    if (manifest.id !== id || manifestProblems(manifest).length > 0) return null;
    cache.set(key, manifest);
    return manifest;
  } catch {
    return null;
  }
}

/**
 * Structural checks that keep generated shell commands safe: no-op outputs
 * are echoed inside single quotes, so they must not contain one.
 */
export function manifestProblems(manifest: HostManifest): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(manifest.output?.noop ?? {})) {
    if (JSON.stringify(value).includes("'")) problems.push(`output.noop.${name} contains a single quote`);
  }
  if (!manifest.config || !manifest.events || !manifest.fields) problems.push('missing config, events or fields');
  return problems;
}

export function loadAllManifests(dir: string = hostsDir()): HostManifest[] {
  return listHostIds(dir)
    .map(id => loadManifest(id, dir))
    .filter((manifest): manifest is HostManifest => manifest !== null);
}
