import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Snapshot, SnapshotTrigger } from './types.js';

const REGISTRY_VERSION = '1.0.0';
const MAX_ENTRIES = 500;

export interface RegistryEntry {
  id: string;
  timestamp: number;
  trigger: SnapshotTrigger;
  project_path: string;
  project_name: string;
  canonical_file: string;
  files_changed_count: number;
}

export interface LastProject {
  path: string;
  name: string;
  last_activity_at: number;
}

export interface Registry {
  version: string;
  last_updated: number;
  last_project?: LastProject;
  snapshots: RegistryEntry[];
}

export function getRegistryPath(): string {
  return join(homedir(), '.bookmark', 'registry.json');
}

function ensureRegistryDir(): void {
  const dir = join(homedir(), '.bookmark');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadRegistry(): Registry {
  const path = getRegistryPath();
  if (!existsSync(path)) {
    return { version: REGISTRY_VERSION, last_updated: 0, snapshots: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Registry;
    if (!parsed.snapshots) parsed.snapshots = [];
    return parsed;
  } catch {
    return { version: REGISTRY_VERSION, last_updated: 0, snapshots: [] };
  }
}

function saveRegistry(registry: Registry): void {
  ensureRegistryDir();
  registry.last_updated = Date.now();
  writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2), 'utf-8');
}

export function appendToRegistry(snapshot: Snapshot, canonicalFile: string): void {
  try {
    const registry = loadRegistry();
    const entry: RegistryEntry = {
      id: snapshot.snapshot_id,
      timestamp: snapshot.timestamp,
      trigger: snapshot.trigger,
      project_path: snapshot.project_path,
      project_name: basename(snapshot.project_path) || snapshot.project_path,
      canonical_file: canonicalFile,
      files_changed_count: snapshot.files_changed.length,
    };

    // Dedupe by id, newest wins
    registry.snapshots = [entry, ...registry.snapshots.filter(e => e.id !== entry.id)];
    if (registry.snapshots.length > MAX_ENTRIES) {
      registry.snapshots.length = MAX_ENTRIES;
    }

    registry.last_project = {
      path: snapshot.project_path,
      name: entry.project_name,
      last_activity_at: snapshot.timestamp,
    };

    saveRegistry(registry);
  } catch {
    // Never break capture for registry bookkeeping
  }
}

export function touchLastProject(projectPath: string): void {
  try {
    const registry = loadRegistry();
    registry.last_project = {
      path: projectPath,
      name: basename(projectPath) || projectPath,
      last_activity_at: Date.now(),
    };
    saveRegistry(registry);
  } catch {
    // Silent — never break restore for bookkeeping
  }
}

export function findById(id: string): RegistryEntry | null {
  const registry = loadRegistry();
  return registry.snapshots.find(e => e.id === id) ?? null;
}

export function getLastProject(): LastProject | null {
  return loadRegistry().last_project ?? null;
}

/** Prune entries whose canonical_file is missing. Lazy cleanup on read paths. */
export function pruneStale(): Registry {
  const registry = loadRegistry();
  const live = registry.snapshots.filter(e => existsSync(e.canonical_file));
  if (live.length !== registry.snapshots.length) {
    registry.snapshots = live;
    saveRegistry(registry);
  }
  return registry;
}
