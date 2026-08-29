import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnapshotId, loadSnapshot, storeSnapshot } from './storage.js';
import type { Snapshot } from '../types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('generateSnapshotId', () => {
  it('keeps adjacent captures distinct', () => {
    const first = generateSnapshotId();
    const second = generateSnapshotId();

    expect(first).toMatch(/^SNAP_\d{8}_\d{6}_\d{3}_[a-f0-9]{4}$/);
    expect(second).toMatch(/^SNAP_\d{8}_\d{6}_\d{3}_[a-f0-9]{4}$/);
    expect(second).not.toBe(first);
  });

  it('continues to load legacy second-resolution snapshot IDs', () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'bookmark-storage-'));
    tempDirs.push(storagePath);
    const snapshot: Snapshot = {
      snapshot_id: 'SNAP_20260829_130536',
      timestamp: Date.now(),
      session_id: 'legacy',
      project_path: storagePath,
      trigger: 'manual',
      compaction_cycle: 0,
      files_changed: [],
      tools_summary: {},
    };

    storeSnapshot(storagePath, snapshot);
    expect(loadSnapshot(storagePath, snapshot.snapshot_id)?.session_id).toBe('legacy');
  });
});
