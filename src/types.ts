// ─── Snapshot Types ───

export interface Snapshot {
  snapshot_id: string;
  timestamp: number;
  session_id: string;
  project_path: string;

  // Trigger metadata
  trigger: SnapshotTrigger;
  compaction_cycle: number;

  // File tracking (the parts that work)
  files_changed: FileActivity[];
  tools_summary: Record<string, number>;

  // Dead fields — kept optional for backward compat with existing snapshots
  // Claude writes these via prompt hooks now, not extracted from transcripts
  context_remaining_pct?: number;
  token_estimate?: number;
  intent?: string;
  progress?: string;
  current_status?: string;
  decisions?: Decision[];
  open_items?: OpenItem[];
  unknowns?: string[];
  errors_encountered?: ErrorEntry[];
  user_sentiment?: 'positive' | 'neutral' | 'negative';

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
  lines_changed?: number;
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
  files_changed_count: number;
  // Dead fields — kept optional for backward compat
  context_remaining_pct?: number;
  token_estimate?: number;
  decisions_count?: number;
  open_items_count?: number;
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

  // Usage counters — only facts, no estimates
  restores_performed?: number;
  tokens_injected?: number;
  quality_blocks?: number;
  boilerplate_caught?: number;
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
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | TranscriptContent[];
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
  maxDecisions: number;
  maxOpenItems: number;
  maxFilesTracked: number;
  maxErrorsTracked: number;
  maxActiveSnapshots: number;
  archiveAfterDays: number;
  snapshotOnSessionEnd: boolean;
  restoreOnSessionStart: boolean;

  verboseLogging: boolean;
}

// ─── Setup Types ───

export interface SetupPreferences {
  intervalMinutes: number;

}
