// Public API exports for @tyroneross/bookmark

export type {
  Snapshot,
  SnapshotTrigger,
  Decision,
  OpenItem,
  FileActivity,
  FileOperation,
  ErrorEntry,
  SnapshotIndex,
  SnapshotEntry,
  IndexStats,
  BookmarkState,
  SessionEntry,
  HookInput,
  HookOutput,
  BookmarkConfig,
} from './types.js';

export { loadConfig, getStoragePath } from './config.js';
export { captureSnapshot } from './snapshot/capture.js';
export { compressToMarkdown } from './snapshot/compress.js';
export {
  storeSnapshot,
  loadSnapshot,
  loadLatestSnapshot,
  listSnapshots,
  readLatestMd,
  writeLatestMd,
  getSnapshotCount,
  ensureStorageDirs,
  generateSnapshotId,
} from './snapshot/storage.js';
export { restoreContext } from './restore/index.js';
export { parseTranscript } from './transcript/parser.js';
export { extractFilesAndTools } from './transcript/extractor.js';
export { loadState, saveState } from './threshold/state.js';
export { getThreshold, shouldSnapshotByThreshold } from './threshold/adaptive.js';
export { checkTimeInterval } from './threshold/time-based.js';
export type {
  ContextUsage,
  ContextUsageObservation,
  UnknownContextLimitUsage,
} from './threshold/token-usage.js';
export {
  handledThresholdsForUsage,
  readLatestContextUsage,
  resolveContextLimit,
  newlyCrossedThresholds,
} from './threshold/token-usage.js';
export { buildHandoffPrompt } from './context/handoff-prompt.js';
export { isContextMdFresh } from './context/freshness.js';
