import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../util/atomic-write.js';
import { ROLES, type HostManifest, type Role } from './manifest.js';

/**
 * Generate and merge one host's hook config from its neutral manifest
 * (`hosts/<id>.json`). This is the only writer of agent hook config files:
 * `bookmark install --host <id>`, `bookmark setup` (Claude settings) and the
 * matching remove paths all go through this module.
 */

export const PACKAGE_NAME = '@tyroneross/bookmark';

/** `--bin` must be plain words: no quotes, `$`, `;`, `|`, `&`, backticks or redirection. */
const SAFE_BIN = /^[A-Za-z0-9@/._ -]+$/;

/** Package root: `dist/host/` or `src/host/` → two levels up. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version;
  } catch {
    return '';
  }
}

/** Unpinned package command, used only where a pin cannot follow releases (the shared plugin hooks file). */
export const UNPINNED_BIN = `npx -y ${PACKAGE_NAME}`;
/** npx pinned to this package's own version, so a hook never runs a newer release by surprise. */
export const PINNED_BIN = packageVersion() ? `npx -y ${PACKAGE_NAME}@${packageVersion()}` : UNPINNED_BIN;

/**
 * Running from a git checkout or `npm link` (package root has `.git`, or is
 * not inside a node_modules directory): the version in package.json may not
 * be on npm, so hooks run this checkout's own build instead.
 */
export function isLocalCheckout(root: string = PACKAGE_ROOT): boolean {
  return existsSync(join(root, '.git')) || !root.split(/[\\/]/).includes('node_modules');
}

export interface DefaultBin {
  bin: string;
  source: 'local-build' | 'pinned-npx';
}

/** Default `--bin`: this checkout's dist when local (and the path is plain), else the pinned npx command. */
export function defaultBin(root: string = PACKAGE_ROOT): DefaultBin {
  const local = `node ${join(root, 'dist', 'cli', 'index.js')}`;
  if (isLocalCheckout(root) && SAFE_BIN.test(local)) return { bin: local, source: 'local-build' };
  return { bin: PINNED_BIN, source: 'pinned-npx' };
}

export const DEFAULT_BIN = defaultBin().bin;

/**
 * Ask npm whether `version` of this package is published. Install-time only,
 * never from a hook. Returns null when npm cannot answer (offline, no npm).
 */
export function isVersionPublished(version: string = packageVersion(), env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (env.BOOKMARK_SKIP_PUBLISH_CHECK === '1' || !version) return null;
  const result = spawnSync('npm', ['view', `${PACKAGE_NAME}@${version}`, 'version'], { encoding: 'utf-8', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    // E404 means npm answered "no such version"; anything else is "could not check".
    return /E404|No match found/i.test(`${result.stderr}${result.stdout}`) ? false : null;
  }
  return result.stdout.trim() === version ? true : false;
}


const ROLE_ALT = [...ROLES, 'check'].join('|');
/**
 * Exactly what `hookCommand` emits with `--host`, for any bin:
 * `<bin> <role> --host <id> 2>/dev/null || (true|echo '<json>')`. `--host` is
 * required so user hooks such as `npm run check 2>/dev/null || true` never
 * match; host-less Bookmark commands always contain the package name.
 */
const GENERATED_COMMAND = new RegExp(`^.+ (?:${ROLE_ALT}) --host [a-z][a-z0-9-]* 2>/dev/null \\|\\| (?:true|echo '[^']*')$`);
/** Legacy prompt-type hooks from Bookmark < 0.3 referenced this file in their `prompt`. */
const LEGACY_PROMPT_MARKER = '.bookmark/bookmark.context.md';
const COMMAND_KEYS = ['command', 'bash', 'powershell'];

export type HookConfig = Record<string, unknown> & { hooks?: Record<string, unknown[]> };

export interface InstallEntry {
  role: Role;
  event: string;
  /** The handler or group placed under hooks[event]. */
  entry: Record<string, unknown>;
}

export function assertSafeBin(bin: string): void {
  if (!SAFE_BIN.test(bin)) {
    throw new Error(`--bin '${bin}' contains characters outside [A-Za-z0-9@/._ -]; pass a plain command such as 'node /path/to/dist/cli/index.js'`);
  }
}

/** Shell command a host runs for one role; the fallback prints the role's no-op output. */
export function hookCommand(
  manifest: HostManifest,
  role: Role,
  bin: string = DEFAULT_BIN,
  options: { host?: boolean } = {}
): string {
  const restoreIsText = role === 'restore' && manifest.output.restore === 'text';
  const noop = JSON.stringify(role === 'stop' ? manifest.output.noop.stop : manifest.output.noop.default);
  const fallback = restoreIsText ? 'true' : `echo '${noop}'`;
  const host = options.host === false ? '' : ` --host ${manifest.id}`;
  return `${bin} ${role}${host} 2>/dev/null || ${fallback}`;
}

export function planEntries(manifest: HostManifest, bin: string = DEFAULT_BIN, options: { host?: boolean } = {}): InstallEntry[] {
  assertSafeBin(bin);
  const { config } = manifest;
  const entries: InstallEntry[] = [];
  for (const role of ROLES) {
    const event = manifest.events[role];
    if (!event) continue;
    const handler: Record<string, unknown> = { type: 'command', [config.commandKey]: hookCommand(manifest, role, bin, options) };
    const timeout = config.timeouts?.[role];
    if (config.timeoutKey && typeof timeout === 'number') handler[config.timeoutKey] = timeout;
    const entry = config.layout === 'grouped'
      ? { ...(config.matcher !== null ? { matcher: config.matcher } : {}), hooks: [handler] }
      : handler;
    entries.push({ role, event, entry });
  }
  return entries;
}

/**
 * A single handler Bookmark wrote: its command names the Bookmark package, or
 * has exactly the generated shape (any `--bin`), or it is a legacy prompt hook.
 * Only command fields are inspected — never `matcher` or other keys.
 */
export function isBookmarkHandler(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const handler = value as Record<string, unknown>;
  for (const key of COMMAND_KEYS) {
    const command = handler[key];
    if (typeof command !== 'string') continue;
    if (command.includes(PACKAGE_NAME) || GENERATED_COMMAND.test(command)) return true;
  }
  return typeof handler.prompt === 'string' && handler.prompt.includes(LEGACY_PROMPT_MARKER);
}

/** True when a group (grouped layout) or handler (flat layout) contains a Bookmark handler. */
export function isBookmarkEntry(value: unknown): boolean {
  if (isBookmarkHandler(value)) return true;
  const hooks = value && typeof value === 'object' ? (value as Record<string, unknown>).hooks : undefined;
  return Array.isArray(hooks) && hooks.some(isBookmarkHandler);
}

/**
 * Remove every Bookmark handler from one event's list, keeping sibling
 * handlers. A group left with no handlers is dropped. Returns the cleaned list
 * and the index where the first Bookmark handler (or its group) was.
 */
function stripBookmark(list: unknown[], layout: HostManifest['config']['layout']): { list: unknown[]; firstIndex: number } {
  const out: unknown[] = [];
  let firstIndex = -1;
  for (const item of list) {
    if (layout === 'flat' || isBookmarkHandler(item)) {
      if (isBookmarkHandler(item)) {
        if (firstIndex === -1) firstIndex = out.length;
        continue;
      }
      out.push(item);
      continue;
    }
    const group = item as Record<string, unknown> | null;
    const handlers = group && Array.isArray(group.hooks) ? group.hooks : null;
    if (!handlers || !handlers.some(isBookmarkHandler)) {
      out.push(item);
      continue;
    }
    if (firstIndex === -1) firstIndex = out.length;
    const kept = handlers.filter(handler => !isBookmarkHandler(handler));
    if (kept.length > 0) out.push({ ...group, hooks: kept });
  }
  return { list: out, firstIndex };
}

/**
 * Merge Bookmark's entries into an existing host config object. Other keys,
 * groups and sibling handlers are kept; every existing Bookmark handler for a
 * mapped event is removed (deduplicated) and one fresh entry is placed where
 * the first one was; nothing changes when the result is identical.
 */
export function mergeHookConfig(
  existing: HookConfig,
  manifest: HostManifest,
  entries: InstallEntry[]
): { merged: HookConfig; changed: boolean } {
  const merged: HookConfig = JSON.parse(JSON.stringify(existing ?? {}));
  if (manifest.config.fileVersion !== null && merged.version === undefined) merged.version = manifest.config.fileVersion;
  const hooks: Record<string, unknown[]> = merged.hooks && typeof merged.hooks === 'object' && !Array.isArray(merged.hooks) ? merged.hooks : {};
  merged.hooks = hooks;
  for (const { event, entry } of entries) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const { list, firstIndex } = stripBookmark(current, manifest.config.layout);
    list.splice(firstIndex === -1 ? list.length : firstIndex, 0, entry);
    hooks[event] = list;
  }
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(existing ?? {}) };
}

/** Remove all Bookmark handlers (any event) from a config object; sibling handlers stay. */
export function removeBookmarkHooks(existing: HookConfig, layout: HostManifest['config']['layout']): { merged: HookConfig; changed: boolean } {
  const merged: HookConfig = JSON.parse(JSON.stringify(existing ?? {}));
  if (!merged.hooks || typeof merged.hooks !== 'object') return { merged, changed: false };
  for (const event of Object.keys(merged.hooks)) {
    const current = merged.hooks[event];
    if (!Array.isArray(current)) continue;
    const { list } = stripBookmark(current, layout);
    if (list.length === 0) delete merged.hooks[event];
    else merged.hooks[event] = list;
  }
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(existing ?? {}) };
}

export function expandHome(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** Read a JSON-object config. Missing → {}. Malformed → throws, so callers leave the file untouched. */
export function readJsonConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message}); left it untouched — fix or move it, then retry`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object; left it untouched`);
  }
  return parsed as HookConfig;
}

/** `~/.bookmark/backups/<host>/`: backups stay out of dotfile repos that may hold the real file. */
export function backupDirFor(host: string, home: string = homedir()): string {
  return join(home, '.bookmark', 'backups', host);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write `config` to `path`: follow a symlink to its target (a dangling link is
 * refused), copy the existing target to `<backupDir>/<name>.<stamp>` (mode
 * 0600, directory 0700), then swap the new bytes in atomically with the
 * target's mode (0600 for a new file). Returns the backup path, if any.
 */
export function writeJsonConfig(
  path: string,
  config: HookConfig,
  options: { now?: Date; backupDir: string }
): string | null {
  let target = path;
  if (isSymlink(path)) {
    if (!existsSync(path)) throw new Error(`${path} is a symlink to a missing file; left it untouched — fix or remove the link, then retry`);
    target = realpathSync(path);
  }
  let mode = 0o600;
  let backupPath: string | null = null;
  if (existsSync(target)) {
    const stats = statSync(target);
    if (!stats.isFile()) throw new Error(`${target} is not a regular file; left it untouched`);
    mode = stats.mode & 0o777;
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const dir = options.backupDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    backupPath = join(dir, `${basename(target)}.${stamp}`);
    copyFileSync(target, backupPath);
    chmodSync(backupPath, 0o600);
  }
  writeFileAtomic(target, JSON.stringify(config, null, 2) + '\n', mode);
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
  const fragment = mergeHookConfig({}, manifest, entries).merged;
  if (compat.status === 'invalid') {
    return { path, changed: false, dryRun: Boolean(options.dryRun), backupPath: null, merged: {}, fragment, compat };
  }
  const existing = readJsonConfig(path);
  const { merged, changed } = mergeHookConfig(existing, manifest, entries);
  let backupPath: string | null = null;
  if (changed && !options.dryRun) {
    backupPath = writeJsonConfig(path, merged, { now: options.now, backupDir: backupDirFor(manifest.id, options.home) });
  }
  return { path, changed, dryRun: Boolean(options.dryRun), backupPath, merged, fragment, compat };
}

/**
 * The plugin's `hooks/hooks.json`, generated from hosts/claude.json. It is
 * loaded by both the Claude Code and the Codex plugin surfaces, so it carries
 * no `--host` (stdin detection picks the dialect) and no version pin (a pin
 * here would go stale on every release-please version bump).
 */
/** Committed self-contained build, relative to the plugin root (built by scripts/build-bundle.mjs). */
export const PLUGIN_BUNDLE = 'bundle/cli/index.mjs';

/**
 * Plugin hook command: run the plugin's own committed bundle, so a plugin
 * installed from GitHub runs that commit's code. npx is the fallback for a
 * host that does not set CLAUDE_PLUGIN_ROOT or a copy without the bundle.
 */
export function pluginHookCommand(role: Role, fallback: string): string {
  const bundle = `"\${CLAUDE_PLUGIN_ROOT:-}/${PLUGIN_BUNDLE}"`;
  return `if [ -f ${bundle} ]; then node ${bundle} ${role}; else ${UNPINNED_BIN} ${role}; fi 2>/dev/null || ${fallback}`;
}

export function pluginHooksConfig(claude: HostManifest): HookConfig {
  // Codex loads this file too: `{}` is a valid Stop no-op for both hosts, `{"decision":"approve"}` is Claude-only.
  const shared: HostManifest = { ...claude, output: { ...claude.output, noop: { ...claude.output.noop, stop: {} } } };
  const entries = planEntries(shared, UNPINNED_BIN, { host: false }).map(item => {
    const generated = hookCommand(shared, item.role, UNPINNED_BIN, { host: false });
    const fallback = generated.slice(generated.lastIndexOf(' || ') + 4);
    const command = pluginHookCommand(item.role, fallback);
    const swap = (handler: Record<string, unknown>) => ({ ...handler, [shared.config.commandKey]: command });
    const entry = Array.isArray(item.entry.hooks)
      ? { ...item.entry, hooks: (item.entry.hooks as Record<string, unknown>[]).map(swap) }
      : swap(item.entry);
    return { ...item, entry };
  });
  return mergeHookConfig({}, shared, entries).merged;
}
