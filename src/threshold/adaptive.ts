import type { BookmarkConfig } from '../types.js';

/**
 * Get the current snapshot threshold based on compaction count.
 *
 * As compaction happens more frequently, snapshot earlier:
 * - 0 compactions: snapshot when 20% context remains
 * - 1 compaction:  snapshot when 30% context remains
 * - 2 compactions: snapshot when 40% context remains
 * - 3+ compactions: snapshot when 50% context remains (capped)
 *
 * @returns threshold as a fraction (0.0-1.0) representing % context remaining
 */
export function getThreshold(compactionCount: number, config: BookmarkConfig): number {
  const { thresholds, maxThreshold } = config;
  const index = Math.min(compactionCount, thresholds.length - 1);
  return Math.min(thresholds[index], maxThreshold);
}

/**
 * Check if current context usage should trigger a snapshot.
 *
 * @param remainingPct - fraction of context remaining (0.0-1.0)
 * @param compactionCount - number of compactions in this session chain
 * @param config - bookmark configuration
 * @returns true if a snapshot should be taken
 */
export function shouldSnapshotByThreshold(
  remainingPct: number,
  compactionCount: number,
  config: BookmarkConfig
): boolean {
  const threshold = getThreshold(compactionCount, config);
  return remainingPct <= threshold;
}
