// ─── Snapshot Types ───

export interface Snapshot {
  snapshot_id: string;
  timestamp: number;
  session_id: string;
  project_path: string;

  // Trigger metadata
  trigger: SnapshotTrigger;
  compaction_cycle: number;
  context_remaining_pct: number;
  token_estimate: number;

  // Extracted content
  current_status: string;
  decisions: Decision[];
  open_items: OpenItem[];
  unknowns: string[];
  files_changed: FileActivity[];
  errors_encountered: ErrorEntry[];
  tools_summary: Record<string, number>;

  // Continuity chain
  prior_snapshot_id?: string;
}

export type SnapshotTrigger = 'pre_compact' | 'time_interval' | 'manual' | 'session_end';

export interface Decision {
  description: string;
  rationale?: string;
  files?: string[];
}

export interface OpenItem {
  description: string;
  priority: 'high' | 'medium' | 'low';
  context?: string;
}

export interface FileActivity {
  path: string;
  operations: FileOperation[];
  summary?: string;
}

export type FileOperation = 'read' | 'write' | 'edit' | 'create' | 'delete';

export interface ErrorEntry {
  message: string;
  tool?: string;
  resolved: boolean;
}

// ─── Index Types ───

export interface SnapshotIndex {
  version: string;
  project_path: string;
  last_updated: number;
  stats: IndexStats;
  snapshots: SnapshotEntry[];
}

export interface IndexStats {
  total_snapshots: number;
  compaction_cycles: number;
  last_compaction: number;
  last_snapshot: number;
  last_time_based: number;
}

export interface SnapshotEntry {
  id: string;
  timestamp: number;
  trigger: SnapshotTrigger;
  compaction_cycle: number;
  context_remaining_pct: number;
  token_estimate: number;
  decisions_count: number;
  files_changed_count: number;
  open_items_count: number;
}

// ─── State Types ───

export interface BookmarkState {
  version: string;
  session_id: string;
  compaction_count: number;
  current_threshold: number;
  last_snapshot_time: number;
  last_event_time: number;
  snapshot_interval_minutes: number;
  session_history: SessionEntry[];
}

export interface SessionEntry {
  session_id: string;
  started: number;
  ended?: number;
  compaction_count: number;
  snapshots_taken: number;
  restored_from?: string;
}

// ─── Transcript Types ───

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  timestamp?: number;
  content: string | TranscriptContent[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

export interface TranscriptContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | TranscriptContent[];
}

export interface TokenEstimate {
  total_tokens: number;
  message_count: number;
  user_tokens: number;
  assistant_tokens: number;
  tool_tokens: number;
  system_tokens: number;
  context_limit: number;
  remaining_pct: number;
  remaining_tokens: number;
}

export interface ExtractionResult {
  current_status: string;
  decisions: Decision[];
  open_items: OpenItem[];
  unknowns: string[];
  files_changed: FileActivity[];
  errors_encountered: ErrorEntry[];
  tools_summary: Record<string, number>;
}

// ─── Hook Input Types ───

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  trigger?: 'manual' | 'auto';
  source?: 'startup' | 'resume' | 'compact' | 'clear';
  custom_instructions?: string;
}

export interface HookOutput {
  systemMessage?: string;
  suppressOutput?: boolean;
}

// ─── Config Types ───

export interface BookmarkConfig {
  storagePath: string;
  thresholds: number[];
  maxThreshold: number;
  intervalMinutes: number;
  contextLimitTokens: number;
  charsPerToken: number;
  maxDecisions: number;
  maxOpenItems: number;
  maxFilesTracked: number;
  maxErrorsTracked: number;
  summaryTokenBudget: number;
  maxActiveSnapshots: number;
  archiveAfterDays: number;
  snapshotOnSessionEnd: boolean;
  restoreOnSessionStart: boolean;
  smartDefault: boolean;
  verboseLogging: boolean;
}

// ─── Setup Types ───

export interface SetupPreferences {
  intervalMinutes: number;
  smartDefault: boolean;
}
