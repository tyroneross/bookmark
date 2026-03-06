import type { TranscriptEntry, FileActivity, FileOperation } from '../types.js';

/**
 * Extractor v0.3 — file tracking + tool summary only.
 *
 * Removed: decision extraction, open items, unknowns, errors, sentiment, status.
 * These produced noise (not signal) via regex. Claude writes semantic content
 * directly via prompt-type hooks instead.
 *
 * Kept: file change tracking (accurate) and tool usage summary (accurate).
 */

const FILE_TOOL_NAMES = new Set(['Write', 'Edit', 'write', 'edit']);
const FILE_CREATING_BASH_PATTERNS = [
  /\b(?:mkdir|touch|mv|cp|cat\s+>|echo\s+>|tee)\b/,
];

export interface ExtractOptions {
  projectPath?: string;
}

export interface FilesAndToolsResult {
  files_changed: FileActivity[];
  tools_summary: Record<string, number>;
}

/**
 * Extract file changes and tool usage from transcript entries.
 * These are the two extraction functions that actually produce accurate data.
 */
export function extractFilesAndTools(entries: TranscriptEntry[], options?: ExtractOptions): FilesAndToolsResult {
  const projectPath = options?.projectPath;
  return {
    files_changed: extractFilesChanged(entries, projectPath),
    tools_summary: extractToolsSummary(entries),
  };
}

function extractFilesChanged(entries: TranscriptEntry[], projectPath?: string): FileActivity[] {
  const fileMap = new Map<string, Set<FileOperation>>();
  const fileLinesChanged = new Map<string, number>();
  const fileStructuralChanges = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (entry.type === 'tool_use') {
      const toolName = entry.tool_name ?? '';
      const input = entry.tool_input ?? {};

      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath = (input.file_path as string) ?? (input.path as string) ?? '';
        if (filePath) {
          if (projectPath && !filePath.startsWith(projectPath)) continue;
          const ops = fileMap.get(filePath) ?? new Set();
          ops.add(toolName.toLowerCase() as FileOperation);
          fileMap.set(filePath, ops);

          const newStr = (input.new_string as string) ?? (input.content as string) ?? '';
          const oldStr = (input.old_string as string) ?? '';
          const linesAdded = newStr ? newStr.split('\n').length : 0;
          const linesRemoved = oldStr ? oldStr.split('\n').length : 0;
          const delta = Math.abs(linesAdded - linesRemoved) + Math.min(linesAdded, linesRemoved);
          fileLinesChanged.set(filePath, (fileLinesChanged.get(filePath) ?? 0) + delta);

          const changes = fileStructuralChanges.get(filePath) ?? new Set();
          extractStructuralHints(newStr, oldStr, changes);
          if (changes.size > 0) {
            fileStructuralChanges.set(filePath, changes);
          }
        }
      }

      if (toolName === 'Bash' || toolName === 'bash') {
        const cmd = (input.command as string) ?? '';
        for (const pattern of FILE_CREATING_BASH_PATTERNS) {
          if (pattern.test(cmd)) {
            const parts = cmd.split(/\s+/);
            const lastPart = parts[parts.length - 1];
            if (lastPart && !lastPart.startsWith('-')) {
              if (projectPath && !lastPart.startsWith(projectPath)) break;
              const ops = fileMap.get(lastPart) ?? new Set();
              ops.add('create');
              fileMap.set(lastPart, ops);
            }
            break;
          }
        }
      }
    }
  }

  const result: FileActivity[] = [];
  for (const [path, ops] of fileMap) {
    const changes = fileStructuralChanges.get(path);
    const summary = changes && changes.size > 0
      ? [...changes].slice(0, 4).join(', ')
      : undefined;
    result.push({
      path,
      operations: [...ops],
      lines_changed: fileLinesChanged.get(path) ?? 0,
      summary,
    });
  }

  return result.slice(0, 20);
}

function extractStructuralHints(newStr: string, oldStr: string, changes: Set<string>): void {
  if (!newStr && !oldStr) return;

  const newLines = new Set(newStr.split('\n').map(l => l.trim()));
  const oldLines = new Set(oldStr.split('\n').map(l => l.trim()));

  const STRUCTURAL_PATTERNS: Array<{ pattern: RegExp; prefix: string }> = [
    { pattern: /^export\s+(?:async\s+)?function\s+(\w+)/, prefix: '+fn' },
    { pattern: /^(?:async\s+)?function\s+(\w+)/, prefix: '+fn' },
    { pattern: /^export\s+(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, prefix: '+fn' },
    { pattern: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, prefix: '+fn' },
    { pattern: /^export\s+class\s+(\w+)/, prefix: '+class' },
    { pattern: /^class\s+(\w+)/, prefix: '+class' },
    { pattern: /^export\s+interface\s+(\w+)/, prefix: '+interface' },
    { pattern: /^interface\s+(\w+)/, prefix: '+interface' },
    { pattern: /^export\s+type\s+(\w+)/, prefix: '+type' },
    { pattern: /^type\s+(\w+)/, prefix: '+type' },
    { pattern: /^import\s+.*from\s+['"]([^'"]+)['"]/, prefix: '+import' },
  ];

  for (const line of newLines) {
    if (oldLines.has(line)) continue;
    for (const { pattern, prefix } of STRUCTURAL_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        changes.add(`${prefix} ${match[1]}`);
        break;
      }
    }
  }

  if (oldStr) {
    for (const line of oldLines) {
      if (newLines.has(line)) continue;
      for (const { pattern, prefix } of STRUCTURAL_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          const removePrefix = prefix.replace('+', '-');
          if (!changes.has(`${prefix} ${match[1]}`)) {
            changes.add(`${removePrefix} ${match[1]}`);
          }
          break;
        }
      }
    }
  }
}

function extractToolsSummary(entries: TranscriptEntry[]): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const entry of entries) {
    if (entry.type === 'tool_use' && entry.tool_name) {
      summary[entry.tool_name] = (summary[entry.tool_name] ?? 0) + 1;
    }
  }

  return summary;
}

// ─── Commit Gap Detection (still useful) ───

export interface CommitGap {
  edits_since_commit: number;
  files_since_commit: number;
  last_commit_index: number;
}

export function extractCommitGap(entries: TranscriptEntry[]): CommitGap {
  let lastCommitIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'tool_use' && (entry.tool_name === 'Bash' || entry.tool_name === 'bash')) {
      const cmd = (entry.tool_input?.command as string) ?? '';
      if (/git\s+commit\b/.test(cmd)) {
        lastCommitIdx = i;
        break;
      }
    }
  }

  let editCount = 0;
  const filesEdited = new Set<string>();
  const searchFrom = lastCommitIdx >= 0 ? lastCommitIdx + 1 : 0;

  for (let i = searchFrom; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === 'tool_use' && FILE_TOOL_NAMES.has(entry.tool_name ?? '')) {
      editCount++;
      const filePath = (entry.tool_input?.file_path as string) ?? '';
      if (filePath) filesEdited.add(filePath);
    }
  }

  return {
    edits_since_commit: editCount,
    files_since_commit: filesEdited.size,
    last_commit_index: lastCommitIdx,
  };
}
