import type { SnapshotTrigger } from '../types.js';

export interface ResolveSnapshotInput {
  trigger: SnapshotTrigger;
  cwd: string;
  explicitTranscriptPath?: string;
  hookTranscriptPath?: string;
  discoverTranscriptPath: (cwd: string) => string | null;
}

export interface ResolvedSnapshotInput {
  transcriptPath?: string;
  mode: 'transcript' | 'manual_fallback' | 'missing_transcript';
  note?: string;
}

export function resolveSnapshotInput(input: ResolveSnapshotInput): ResolvedSnapshotInput {
  const transcriptPath =
    input.explicitTranscriptPath ??
    input.hookTranscriptPath ??
    input.discoverTranscriptPath(input.cwd);

  if (transcriptPath) {
    return {
      transcriptPath,
      mode: 'transcript',
    };
  }

  if (input.trigger === 'manual') {
    return {
      mode: 'manual_fallback',
      note: 'No transcript found. Falling back to existing Bookmark trails for this manual checkpoint.',
    };
  }

  return {
    mode: 'missing_transcript',
  };
}
