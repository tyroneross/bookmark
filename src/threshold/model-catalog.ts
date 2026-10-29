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

/** Context window for `model` from the cached catalog, or null (stale cache is fine; missing cache is null). */
export function lookupCatalogContextWindow(model: string, path: string = modelCatalogPath()): number | null {
  const catalog = readCatalog(path);
  if (!catalog) return null;
  const wanted = model.toLowerCase();
  const bare = wanted.includes('/') ? wanted.slice(wanted.lastIndexOf('/') + 1) : wanted;
  for (const provider of Object.values(catalog)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [id, entry] of Object.entries(provider.models)) {
      if (id.toLowerCase() !== wanted && id.toLowerCase() !== bare) continue;
      if (!isRecord(entry) || !isRecord(entry.limit)) continue;
      const context = entry.limit.context;
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) return context;
    }
  }
  return null;
}

/** Download the catalog into the cache file. Explicit user command only; never called from a hook. */
export async function refreshModelCatalog(path: string = modelCatalogPath()): Promise<{ path: string; providers: number }> {
  const response = await fetch(MODEL_CATALOG_URL);
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const parsed = await response.json();
  if (!isRecord(parsed)) throw new Error('models.dev returned an unexpected shape');
  writeFileAtomic(path, JSON.stringify(parsed));
  cached = null;
  return { path, providers: Object.keys(parsed).length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
