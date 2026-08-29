import { describe, expect, it } from 'vitest';
import { incrementCompaction, resetForNewSession } from './state.js';
import type { BookmarkState } from '../types.js';

function state(): BookmarkState {
  return {
    version: '1.0.0',
    session_id: 'old-session',
    compaction_count: 0,
    current_threshold: 0.2,
    last_snapshot_time: 0,
    last_event_time: 1,
    snapshot_interval_minutes: 5,
    session_history: [],
    token_thresholds_triggered: [0.75],
    latest_model: 'claude-opus-5',
    latest_context_used_pct: 0.8,
    unknown_context_limit_notified_model: 'claude-opus-5',
  };
}

describe('token threshold lifecycle', () => {
  it('keeps a handled threshold until lower post-compaction usage is observed', () => {
    const next = incrementCompaction(state(), [0.2, 0.3]);
    expect(next.compaction_count).toBe(1);
    expect(next.token_thresholds_triggered).toEqual([0.75]);
  });

  it('clears prior usage observations for a new session', () => {
    const next = resetForNewSession(state(), 'new-session', [0.2]);
    expect(next.session_id).toBe('new-session');
    expect(next.token_thresholds_triggered).toEqual([]);
    expect(next.latest_model).toBeUndefined();
    expect(next.latest_context_used_pct).toBeUndefined();
    expect(next.unknown_context_limit_notified_model).toBeUndefined();
  });
});
