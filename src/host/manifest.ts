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
    if (manifest.id !== id) return null;
    cache.set(key, manifest);
    return manifest;
  } catch {
    return null;
  }
}

export function loadAllManifests(dir: string = hostsDir()): HostManifest[] {
  return listHostIds(dir)
    .map(id => loadManifest(id, dir))
    .filter((manifest): manifest is HostManifest => manifest !== null);
}
