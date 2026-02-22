import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot, SnapshotIndex, SnapshotEntry } from '../types.js';

const INDEX_VERSION = '1.0.0';

function generateSnapshotId(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `SNAP_${date}_${time}`;
}

export function getSnapshotsDir(storagePath: string): string {
  return join(storagePath, 'snapshots');
}

export function getLatestPath(storagePath: string): string {
  return join(storagePath, 'LATEST.md');
}

export function getIndexPath(storagePath: string): string {
  return join(storagePath, 'index.json');
}

export function ensureStorageDirs(storagePath: string): void {
  const dirs = [
    storagePath,
    join(storagePath, 'snapshots'),
    join(storagePath, 'archive'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

export function storeSnapshot(storagePath: string, snapshot: Snapshot): string {
  ensureStorageDirs(storagePath);

  const snapshotId = snapshot.snapshot_id || generateSnapshotId();
  const snapshotPath = join(getSnapshotsDir(storagePath), `${snapshotId}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');

  // Update index
  updateIndex(storagePath, snapshot);

  return snapshotId;
}

export function loadSnapshot(storagePath: string, snapshotId: string): Snapshot | null {
  // Validate snapshot ID format to prevent path traversal
  if (!/^SNAP_\d{8}_\d{6}$/.test(snapshotId)) {
    return null;
  }

  const snapshotPath = join(getSnapshotsDir(storagePath), `${snapshotId}.json`);
  if (!existsSync(snapshotPath)) return null;

  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8')) as Snapshot;
  } catch {
    return null;
  }
}

export function loadLatestSnapshot(storagePath: string): Snapshot | null {
  const index = loadIndex(storagePath);
  if (!index || index.snapshots.length === 0) return null;

  const latestEntry = index.snapshots[0]; // Most recent first
  return loadSnapshot(storagePath, latestEntry.id);
}

export function listSnapshots(storagePath: string, limit = 10): SnapshotEntry[] {
  const index = loadIndex(storagePath);
  if (!index) return [];
  return index.snapshots.slice(0, limit);
}

export function writeLatestMd(storagePath: string, content: string): void {
  ensureStorageDirs(storagePath);
  writeFileSync(getLatestPath(storagePath), content, 'utf-8');
}

export function readLatestMd(storagePath: string): string | null {
  const path = getLatestPath(storagePath);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function loadIndex(storagePath: string): SnapshotIndex | null {
  const indexPath = getIndexPath(storagePath);
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(readFileSync(indexPath, 'utf-8')) as SnapshotIndex;
  } catch {
    return null;
  }
}

function updateIndex(storagePath: string, snapshot: Snapshot): void {
  const indexPath = getIndexPath(storagePath);

  let index: SnapshotIndex = loadIndex(storagePath) ?? {
    version: INDEX_VERSION,
    project_path: snapshot.project_path,
    last_updated: Date.now(),
    stats: {
      total_snapshots: 0,
      compaction_cycles: 0,
      last_compaction: 0,
      last_snapshot: 0,
      last_time_based: 0,
    },
    snapshots: [],
  };

  const entry: SnapshotEntry = {
    id: snapshot.snapshot_id,
    timestamp: snapshot.timestamp,
    trigger: snapshot.trigger,
    compaction_cycle: snapshot.compaction_cycle,
    context_remaining_pct: snapshot.context_remaining_pct,
    token_estimate: snapshot.token_estimate,
    decisions_count: snapshot.decisions.length,
    files_changed_count: snapshot.files_changed.length,
    open_items_count: snapshot.open_items.length,
  };

  // Add to front (most recent first)
  index.snapshots.unshift(entry);

  // Update stats
  index.stats.total_snapshots = index.snapshots.length;
  index.stats.last_snapshot = snapshot.timestamp;
  index.last_updated = Date.now();

  if (snapshot.trigger === 'pre_compact') {
    index.stats.compaction_cycles = snapshot.compaction_cycle;
    index.stats.last_compaction = snapshot.timestamp;
  }
  if (snapshot.trigger === 'time_interval') {
    index.stats.last_time_based = snapshot.timestamp;
  }

  // Cap active snapshots
  if (index.snapshots.length > 50) {
    index.snapshots.length = 50;
  }

  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

export function getSnapshotCount(storagePath: string): number {
  const snapshotsDir = getSnapshotsDir(storagePath);
  if (!existsSync(snapshotsDir)) return 0;
  try {
    return readdirSync(snapshotsDir).filter(f => f.startsWith('SNAP_') && f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
