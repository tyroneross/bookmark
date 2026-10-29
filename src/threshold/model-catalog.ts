import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomic-write.js';

/**
 * Cached models.dev catalog (`https://models.dev/api.json`): provider → models →
 * `limit.context`. Read only from a local cache file so hooks never touch the
 * network; `bookmark catalog refresh` fills the cache on demand.
 */
export const MODEL_CATALOG_URL = 'https://models.dev/api.json';

/** `BOOKMARK_MODEL_CATALOG`, else `$XDG_CACHE_HOME/bookmark/models-dev.json`, else `~/.cache/bookmark/models-dev.json`. */
export function modelCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOKMARK_MODEL_CATALOG) return env.BOOKMARK_MODEL_CATALOG;
  const cacheRoot = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cacheRoot, 'bookmark', 'models-dev.json');
}

let cached: { path: string; data: Record<string, unknown> | null } | null = null;

function readCatalog(path: string): Record<string, unknown> | null {
  if (cached?.path === path) return cached.data;
  let data: Record<string, unknown> | null = null;
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      if (isRecord(parsed)) data = parsed;
    }
  } catch {
    data = null;
  }
  cached = { path, data };
  return data;
}

/**
 * Context window for `model` from the cached catalog, or null (a stale cache
 * is fine; a missing cache is null). `provider/model` looks only in that
 * provider. An unqualified id must resolve to one value: matches in several
 * providers that disagree are ambiguous and return null.
 */
export function lookupCatalogContextWindow(model: string, path: string = modelCatalogPath()): number | null {
  const catalog = readCatalog(path);
  if (!catalog) return null;
  const wanted = model.toLowerCase();
  const slash = wanted.indexOf('/');
  const providerHint = slash > 0 ? wanted.slice(0, slash) : null;
  const bare = slash > 0 ? wanted.slice(slash + 1) : wanted;
  const values = new Set<number>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (providerHint && providerId.toLowerCase() !== providerHint) continue;
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [id, entry] of Object.entries(provider.models)) {
      if (id.toLowerCase() !== bare) continue;
      if (!isRecord(entry) || !isRecord(entry.limit)) continue;
      const context = entry.limit.context;
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) values.add(context);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}

/** Download the catalog into the cache file. Explicit user command only; never called from a hook. */
export const CATALOG_TIMEOUT_MS = 15_000;
export const CATALOG_MAX_BYTES = 10 * 1024 * 1024;

export async function refreshModelCatalog(path: string = modelCatalogPath()): Promise<{ path: string; providers: number }> {
  const response = await fetch(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > CATALOG_MAX_BYTES) throw new Error(`models.dev catalog is ${declared} bytes, over the ${CATALOG_MAX_BYTES}-byte cap`);
  const text = await readCapped(response, CATALOG_MAX_BYTES);
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('models.dev returned an unexpected shape');
  writeFileAtomic(path, JSON.stringify(parsed));
  cached = null;
  return { path, providers: Object.keys(parsed).length };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`models.dev catalog exceeded the ${maxBytes}-byte cap`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
