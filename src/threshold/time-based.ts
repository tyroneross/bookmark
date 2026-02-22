import type { BookmarkState } from '../types.js';

export interface TimeCheckResult {
  shouldSnapshot: boolean;
  elapsedMinutes: number;
  intervalMinutes: number;
  reason?: string;
}

/**
 * Check if the time-based snapshot interval has elapsed.
 * Piggybacks on UserPromptSubmit events — no timer needed.
 */
export function checkTimeInterval(state: BookmarkState): TimeCheckResult {
  const now = Date.now();
  const intervalMs = state.snapshot_interval_minutes * 60 * 1000;
  const elapsed = now - (state.last_snapshot_time || now);
  const elapsedMinutes = Math.floor(elapsed / 60_000);

  if (state.last_snapshot_time > 0 && elapsed >= intervalMs) {
    return {
      shouldSnapshot: true,
      elapsedMinutes,
      intervalMinutes: state.snapshot_interval_minutes,
      reason: `${elapsedMinutes}min since last snapshot (interval: ${state.snapshot_interval_minutes}min)`,
    };
  }

  return {
    shouldSnapshot: false,
    elapsedMinutes,
    intervalMinutes: state.snapshot_interval_minutes,
  };
}
