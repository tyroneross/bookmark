import type { TranscriptEntry, ExtractionResult, Decision, OpenItem, FileActivity, ErrorEntry, FileOperation } from '../types.js';

// ─── Pattern Definitions ───

const DECISION_PATTERNS = [
  /\b(?:decided to|chose|going with|approach:|instead of|opted for|settled on|will use|let's go with|I'll use|we'll use)\b/i,
  /\b(?:because|since|rationale:|reason:|the advantage|better approach)\b/i,
];

const OPEN_ITEM_PATTERNS = [
  /\b(?:still need to|TODO|next step|remaining|haven't yet|need to|should also|left to do|pending)\b/i,
  /- \[ \]/,  // Unchecked markdown checkbox
  /\b(?:will need to|must still|haven't implemented|not yet)\b/i,
];

const UNKNOWN_PATTERNS = [
  /\b(?:not sure|unclear|blocker|blocked by|need to figure out|question:|unknown|investigate|TBD)\b/i,
  /\b(?:might need|may require|haven't determined|needs research|uncertain)\b/i,
];

const ERROR_PATTERNS = [
  /\b(?:error|Error|ERROR|exception|Exception|traceback|Traceback|failed|FAILED)\b/,
  /\b(?:TypeError|SyntaxError|ReferenceError|cannot find|not found|undefined is not)\b/,
  /\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT)\b/,
];

const FILE_TOOL_NAMES = new Set(['Write', 'Edit', 'write', 'edit']);
const FILE_CREATING_BASH_PATTERNS = [
  /\b(?:mkdir|touch|mv|cp|cat\s+>|echo\s+>|tee)\b/,
];

/**
 * Extract structured context from transcript entries using pattern matching.
 * Zero LLM calls — pure heuristic extraction.
 */
export function extractFromEntries(entries: TranscriptEntry[]): ExtractionResult {
  const decisions = extractDecisions(entries);
  const openItems = extractOpenItems(entries);
  const unknowns = extractUnknowns(entries);
  const filesChanged = extractFilesChanged(entries);
  const errors = extractErrors(entries);
  const toolsSummary = extractToolsSummary(entries);
  const currentStatus = extractCurrentStatus(entries);

  return {
    current_status: currentStatus,
    decisions,
    open_items: openItems,
    unknowns,
    files_changed: filesChanged,
    errors_encountered: errors,
    tools_summary: toolsSummary,
  };
}

function extractDecisions(entries: TranscriptEntry[]): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const text = getEntryText(entry);
    if (!text) continue;

    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(text)) {
        // Extract the sentence containing the decision
        const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 10);
        for (const sentence of sentences) {
          if (DECISION_PATTERNS.some(p => p.test(sentence))) {
            const clean = sentence.trim().slice(0, 200);
            const key = clean.toLowerCase().slice(0, 50);
            if (!seen.has(key)) {
              seen.add(key);
              decisions.push({ description: clean });
            }
          }
        }
        break;
      }
    }
  }

  return decisions.slice(0, 15); // maxDecisions
}

function extractOpenItems(entries: TranscriptEntry[]): OpenItem[] {
  const items: OpenItem[] = [];
  const seen = new Set<string>();

  // Process in reverse — more recent items are more relevant
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const text = getEntryText(entry);
    if (!text) continue;

    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 10);
    for (const sentence of sentences) {
      if (OPEN_ITEM_PATTERNS.some(p => p.test(sentence))) {
        const clean = sentence.trim().slice(0, 200);
        const key = clean.toLowerCase().slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            description: clean,
            priority: inferPriority(clean),
          });
        }
      }
    }
  }

  return items.slice(0, 10); // maxOpenItems
}

function extractUnknowns(entries: TranscriptEntry[]): string[] {
  const unknowns: string[] = [];
  const seen = new Set<string>();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const text = getEntryText(entry);
    if (!text) continue;

    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 10);
    for (const sentence of sentences) {
      if (UNKNOWN_PATTERNS.some(p => p.test(sentence))) {
        const clean = sentence.trim().slice(0, 200);
        const key = clean.toLowerCase().slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          unknowns.push(clean);
        }
      }
    }
  }

  return unknowns.slice(0, 10);
}

function extractFilesChanged(entries: TranscriptEntry[]): FileActivity[] {
  const fileMap = new Map<string, Set<FileOperation>>();

  for (const entry of entries) {
    if (entry.type === 'tool_use') {
      const toolName = entry.tool_name ?? '';
      const input = entry.tool_input ?? {};

      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath = (input.file_path as string) ?? (input.path as string) ?? '';
        if (filePath) {
          const ops = fileMap.get(filePath) ?? new Set();
          ops.add(toolName.toLowerCase() as FileOperation);
          fileMap.set(filePath, ops);
        }
      }

      // Detect file operations in Bash commands
      if (toolName === 'Bash' || toolName === 'bash') {
        const cmd = (input.command as string) ?? '';
        for (const pattern of FILE_CREATING_BASH_PATTERNS) {
          if (pattern.test(cmd)) {
            // Try to extract file path from command
            const parts = cmd.split(/\s+/);
            const lastPart = parts[parts.length - 1];
            if (lastPart && !lastPart.startsWith('-')) {
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
    result.push({ path, operations: [...ops] });
  }

  return result.slice(0, 20); // maxFilesTracked
}

function extractErrors(entries: TranscriptEntry[]): ErrorEntry[] {
  const errors: ErrorEntry[] = [];
  const seen = new Set<string>();
  const resolvedFiles = new Set<string>();

  // First pass: find files that were successfully edited after errors
  for (const entry of entries) {
    if (entry.type === 'tool_use' && FILE_TOOL_NAMES.has(entry.tool_name ?? '')) {
      const filePath = (entry.tool_input?.file_path as string) ?? '';
      if (filePath) resolvedFiles.add(filePath);
    }
  }

  for (const entry of entries) {
    if (entry.type !== 'tool_result') continue;
    const text = getEntryText(entry);
    if (!text) continue;

    if (ERROR_PATTERNS.some(p => p.test(text))) {
      // Extract first line of error
      const firstLine = text.split('\n')[0]?.trim().slice(0, 200) ?? '';
      const key = firstLine.toLowerCase().slice(0, 50);

      if (!seen.has(key) && firstLine) {
        seen.add(key);
        errors.push({
          message: firstLine,
          tool: entry.tool_name,
          resolved: false, // Will be updated below
        });
      }
    }
  }

  return errors.slice(0, 10); // maxErrorsTracked
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

function extractCurrentStatus(entries: TranscriptEntry[]): string {
  // Find the last substantial assistant message
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const text = getEntryText(entry);
    if (!text || text.length < 50) continue;

    // Take first 2-3 sentences or 300 chars
    const sentences = text.split(/(?<=[.!?])\s+/).slice(0, 3);
    return sentences.join(' ').slice(0, 300);
  }

  return 'No status available';
}

function getEntryText(entry: TranscriptEntry): string {
  if (typeof entry.content === 'string') return entry.content;
  return '';
}

function inferPriority(text: string): 'high' | 'medium' | 'low' {
  const lower = text.toLowerCase();
  if (/\b(?:must|critical|urgent|blocker|breaking|immediately)\b/.test(lower)) return 'high';
  if (/\b(?:should|important|next|before|required)\b/.test(lower)) return 'medium';
  return 'low';
}
