import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomic-write.js';
import { ROLES, type HostManifest, type Role } from './manifest.js';

/**
 * Generate and merge one host's hook config from its neutral manifest
 * (`hosts/<id>.json`). This is the only writer of agent hook config files:
 * `bookmark install --host <id>` and `bookmark setup` (Claude settings) both
 * go through `mergeHookConfig`.
 */

export const DEFAULT_BIN = 'npx @tyroneross/bookmark';
const BOOKMARK_MARKERS = ['@tyroneross/bookmark', '.bookmark/bookmark.context.md'];
/** `<anything>bookmark<path> <role> --host <id>`: a Bookmark command written with a custom `--bin`. */
const ROLE_COMMAND = new RegExp(`bookmark\\S*\\s+(?:${[...ROLES, 'check'].join('|')})\\s+--host\\s+[a-z]`);

export type HookConfig = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

export interface InstallEntry {
  role: Role;
  event: string;
  /** The handler or group placed under hooks[event]. */
  entry: Record<string, unknown>;
}

/** Shell command a host runs for one role; the fallback prints the role's no-op output. */
export function hookCommand(manifest: HostManifest, role: Role, bin: string = DEFAULT_BIN): string {
  const restoreIsText = role === 'restore' && manifest.output.restore === 'text';
  const noop = JSON.stringify(role === 'stop' ? manifest.output.noop.stop : manifest.output.noop.default);
  const fallback = restoreIsText ? 'true' : `echo '${noop}'`;
  return `${bin} ${role} --host ${manifest.id} 2>/dev/null || ${fallback}`;
}

export function planEntries(manifest: HostManifest, bin: string = DEFAULT_BIN): InstallEntry[] {
  const { config } = manifest;
  const entries: InstallEntry[] = [];
  for (const role of ROLES) {
    const event = manifest.events[role];
    if (!event) continue;
    const handler: Record<string, unknown> = { type: 'command', [config.commandKey]: hookCommand(manifest, role, bin) };
    const timeout = config.timeouts?.[role];
    if (config.timeoutKey && typeof timeout === 'number') handler[config.timeoutKey] = timeout;
    const entry = config.layout === 'grouped'
      ? { ...(config.matcher !== null ? { matcher: config.matcher } : {}), hooks: [handler] }
      : handler;
    entries.push({ role, event, entry });
  }
  return entries;
}

function commandsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const own = Object.values(record).filter((v): v is string => typeof v === 'string');
  const nested = Array.isArray(record.hooks) ? record.hooks.flatMap(commandsOf) : [];
  return [...own, ...nested];
}

/** A group or handler that Bookmark wrote (any version, any `--bin`). */
export function isBookmarkEntry(value: unknown, bin?: string): boolean {
  return commandsOf(value).some(text =>
    BOOKMARK_MARKERS.some(marker => text.includes(marker)) ||
    (bin !== undefined && text.includes(bin)) ||
    ROLE_COMMAND.test(text)
  );
}

/**
 * Merge Bookmark's entries into an existing host config object. Other hooks
 * and keys are kept; an existing Bookmark entry for an event is replaced in
 * place; nothing changes when the result is identical (idempotent).
 */
export function mergeHookConfig(
  existing: HookConfig,
  manifest: HostManifest,
  entries: InstallEntry[],
  bin?: string
): { merged: HookConfig; changed: boolean } {
  const merged: HookConfig = JSON.parse(JSON.stringify(existing ?? {}));
  if (manifest.config.fileVersion !== null && merged.version === undefined) merged.version = manifest.config.fileVersion;
  const hooks: Record<string, unknown[]> = merged.hooks && typeof merged.hooks === 'object' ? merged.hooks : {};
  merged.hooks = hooks;
  for (const { event, entry } of entries) {
    const list = Array.isArray(hooks[event]) ? hooks[event] : [];
    const index = list.findIndex(item => isBookmarkEntry(item, bin));
    if (index === -1) list.push(entry);
    else list[index] = entry;
    hooks[event] = list;
  }
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(existing ?? {}) };
}

export function expandHome(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

export function readJsonConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as HookConfig;
}

/** Write `config` to `path` atomically, copying the previous file to `<path>.bookmark-backup-<stamp>` first. */
export function writeJsonConfig(path: string, config: HookConfig, options: { backup: boolean; now?: Date }): string | null {
  let backupPath: string | null = null;
  if (options.backup && existsSync(path)) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backupPath = `${path}.bookmark-backup-${stamp}`;
    copyFileSync(path, backupPath);
  }
  writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n');
  return backupPath;
}

export interface CompatResult {
  status: 'ok' | 'invalid' | 'unavailable';
  /** Event names not listed for this host by the compatibility registry. */
  unknownEvents: string[];
  message?: string;
}

/**
 * Validate event names against `rosslabs-lsp compat --section agent-hooks`
 * (JSON on stdout; record `agent-hooks.<host>.hook-config-location`, whose
 * `validity.capabilities` lists `event:<Name>`). The registry file itself is
 * never parsed here. A missing binary or record is `unavailable`, not a failure.
 */
export function validateEventsWithCompat(
  manifest: HostManifest,
  events: string[],
  env: NodeJS.ProcessEnv = process.env
): CompatResult {
  const bin = env.BOOKMARK_COMPAT_BIN || 'rosslabs-lsp';
  const result = spawnSync(bin, ['compat', '--section', 'agent-hooks'], { encoding: 'utf-8', timeout: 15_000 });
  if (result.error || result.status !== 0) {
    return { status: 'unavailable', unknownEvents: [], message: `${bin} compat unavailable (${result.error?.message ?? `exit ${result.status}`})` };
  }
  let records: unknown[];
  try {
    const parsed = JSON.parse(result.stdout) as { records?: unknown[] };
    records = Array.isArray(parsed.records) ? parsed.records : [];
  } catch {
    return { status: 'unavailable', unknownEvents: [], message: `${bin} compat printed non-JSON output` };
  }
  const id = `agent-hooks.${manifest.id}.hook-config-location`;
  const record = records.find(r => (r as { id?: unknown })?.id === id) as
    | { validity?: { capabilities?: unknown } }
    | undefined;
  const capabilities = Array.isArray(record?.validity?.capabilities) ? record.validity.capabilities : null;
  if (!capabilities) {
    return { status: 'unavailable', unknownEvents: [], message: `no ${id} record in ${bin} compat output` };
  }
  const known = new Set(capabilities.filter((c): c is string => typeof c === 'string' && c.startsWith('event:')).map(c => c.slice(6)));
  const unknownEvents = events.filter(event => !known.has(event));
  return unknownEvents.length > 0
    ? { status: 'invalid', unknownEvents, message: `${manifest.id}: events not in ${id}: ${unknownEvents.join(', ')}` }
    : { status: 'ok', unknownEvents: [] };
}

export interface InstallResult {
  path: string;
  changed: boolean;
  dryRun: boolean;
  backupPath: string | null;
  merged: HookConfig;
  fragment: HookConfig;
  compat: CompatResult;
}

/** Plan, validate and (unless dry-run) merge one host's hooks into its config file. */
export function installHost(
  manifest: HostManifest,
  options: { bin?: string; dryRun?: boolean; home?: string; env?: NodeJS.ProcessEnv; now?: Date } = {}
): InstallResult {
  const bin = options.bin ?? DEFAULT_BIN;
  const entries = planEntries(manifest, bin);
  const compat = validateEventsWithCompat(manifest, entries.map(e => e.event), options.env);
  const path = expandHome(manifest.config.path, options.home);
  const fragment = mergeHookConfig({}, manifest, entries, bin).merged;
  if (compat.status === 'invalid') {
    return { path, changed: false, dryRun: Boolean(options.dryRun), backupPath: null, merged: {}, fragment, compat };
  }
  const existing = readJsonConfig(path);
  const { merged, changed } = mergeHookConfig(existing, manifest, entries, bin);
  let backupPath: string | null = null;
  if (changed && !options.dryRun) backupPath = writeJsonConfig(path, merged, { backup: true, now: options.now });
  return { path, changed, dryRun: Boolean(options.dryRun), backupPath, merged, fragment, compat };
}
