import type { TranscriptEntry, ExtractionResult, Decision, OpenItem, FileActivity, ErrorEntry, FileOperation } from '../types.js';

// ─── Pattern Definitions ───

const DECISION_PATTERNS = [
  /\b(?:decided to|chose|going with|approach:|instead of|opted for|settled on)\b/i,
  /\b(?:rationale:|reason:|the advantage|better approach)\b/i,
];

/** Patterns that indicate conversational narration, not decisions */
const DECISION_NOISE = [
  /^let me /i,
  /^I'll /i,
  /^ok so /i,
  /^now /i,
  /^here /i,
  /^the /i,
  /^this /i,
  /^it returned/i,
  /^0 /,
  /^first /i,
];

const OPEN_ITEM_PATTERNS = [
  /\b(?:still need to|TODO|next step|remaining|left to do|pending)\b/i,
  /- \[ \]/,  // Unchecked markdown checkbox
  /\b(?:will need to|must still|haven't implemented)\b/i,
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

export interface ExtractOptions {
  /** Project root path — used to scope file tracking and relevance filtering */
  projectPath?: string;
}

/**
 * Extract structured context from transcript entries using pattern matching.
 * Zero LLM calls — pure heuristic extraction.
 */
export function extractFromEntries(entries: TranscriptEntry[], options?: ExtractOptions): ExtractionResult {
  const projectPath = options?.projectPath;
  const decisions = extractDecisions(entries);
  const openItems = extractOpenItems(entries);
  const unknowns = extractUnknowns(entries);
  const filesChanged = extractFilesChanged(entries, projectPath);
  const errors = extractErrors(entries);
  const toolsSummary = extractToolsSummary(entries);
  const currentStatus = extractCurrentStatus(entries);
  const sentiment = extractUserSentiment(entries);

  return {
    current_status: currentStatus,
    decisions,
    open_items: openItems,
    unknowns,
    files_changed: filesChanged,
    errors_encountered: errors,
    tools_summary: toolsSummary,
    user_sentiment: sentiment,
  };
}

function extractDecisions(entries: TranscriptEntry[]): Decision[] {
  const decisions: Decision[] = [];
  const seen = new Set<string>();

  // Only look at entries that are clearly decision-oriented
  // Require BOTH a decision keyword AND a rationale keyword in the same message
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue;
    const text = getEntryText(entry);
    if (!text || text.length < 30) continue;
    // Skip long blocks (research output, code)
    if (text.length > 2000) continue;
    // Skip messages with markdown headers (formatted output, not decisions)
    if (/^#{1,3}\s/m.test(text)) continue;

    // Must have a decision keyword
    if (!DECISION_PATTERNS[0].test(text)) continue;

    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 25);
    for (const sentence of sentences) {
      if (DECISION_PATTERNS[0].test(sentence)) {
        const clean = sentence.trim().slice(0, 150);
        if (DECISION_NOISE.some(p => p.test(clean))) continue;
        if (clean.split(/\s+/).length < 6) continue;
        const key = clean.toLowerCase().slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          decisions.push({ description: clean });
        }
      }
    }
  }

  return decisions.slice(0, 6);
}

/** Fragments that look like open items but are just conversational narration */
const OPEN_ITEM_NOISE = [
  /^let me /i,
  /^I'll /i,
  /^I need to /i,
  /^I should /i,
  /^now I /i,
  /^now let me /i,
  /^first,? /i,
  /^next,? /i,
  /^let's /i,
  /^we need to /i,
  /^you'll need to /i,
  /^no need to /i,
  /^there's no need /i,
];

function extractOpenItems(entries: TranscriptEntry[]): OpenItem[] {
  const items: OpenItem[] = [];
  const seen = new Set<string>();

  // Process in reverse — more recent items are more relevant
  // Only look at last 30% of entries
  const startIdx = Math.floor(entries.length * 0.7);
  for (let i = entries.length - 1; i >= startIdx; i--) {
    const entry = entries[i];
    // Accept both assistant and user messages for TODOs
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    const text = getEntryText(entry);
    if (!text || text.length > 2000) continue;
    // Skip formatted research/output blocks
    if (/^#{1,3}\s/m.test(text)) continue;

    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 25);
    for (const sentence of sentences) {
      if (OPEN_ITEM_PATTERNS.some(p => p.test(sentence))) {
        const clean = sentence.trim().slice(0, 150);
        if (OPEN_ITEM_NOISE.some(p => p.test(clean))) continue;
        if (clean.split(/\s+/).length < 5) continue;
        // Skip items that look like bullet points from research output
        if (/^\*\*/.test(clean) || /^-\s+\*\*/.test(clean)) continue;
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

  return items.slice(0, 5);
}

function extractUnknowns(entries: TranscriptEntry[]): string[] {
  const unknowns: string[] = [];
  const seen = new Set<string>();

  // Only recent entries, skip research/formatted output
  const startIdx = Math.floor(entries.length * 0.7);
  for (let i = entries.length - 1; i >= startIdx; i--) {
    const entry = entries[i];
    if (entry.type !== 'assistant' && entry.type !== 'user') continue;
    const text = getEntryText(entry);
    if (!text || text.length > 2000) continue;
    if (/^#{1,3}\s/m.test(text)) continue;

    const sentences = text.split(/[.!?\n]/).filter(s => s.trim().length > 20);
    for (const sentence of sentences) {
      if (UNKNOWN_PATTERNS.some(p => p.test(sentence))) {
        const clean = sentence.trim().slice(0, 150);
        if (clean.split(/\s+/).length < 5) continue;
        if (/^let me /i.test(clean)) continue;
        const key = clean.toLowerCase().slice(0, 50);
        if (!seen.has(key)) {
          seen.add(key);
          unknowns.push(clean);
        }
      }
    }
  }

  return unknowns.slice(0, 3);
}

function extractFilesChanged(entries: TranscriptEntry[], projectPath?: string): FileActivity[] {
  const fileMap = new Map<string, Set<FileOperation>>();
  const fileLinesChanged = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === 'tool_use') {
      const toolName = entry.tool_name ?? '';
      const input = entry.tool_input ?? {};

      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath = (input.file_path as string) ?? (input.path as string) ?? '';
        if (filePath) {
          // Skip files outside the project directory
          if (projectPath && !filePath.startsWith(projectPath)) continue;
          const ops = fileMap.get(filePath) ?? new Set();
          ops.add(toolName.toLowerCase() as FileOperation);
          fileMap.set(filePath, ops);

          // Estimate lines changed from Edit tool inputs
          const newStr = (input.new_string as string) ?? (input.content as string) ?? '';
          const oldStr = (input.old_string as string) ?? '';
          const linesAdded = newStr ? newStr.split('\n').length : 0;
          const linesRemoved = oldStr ? oldStr.split('\n').length : 0;
          const delta = Math.abs(linesAdded - linesRemoved) + Math.min(linesAdded, linesRemoved);
          fileLinesChanged.set(filePath, (fileLinesChanged.get(filePath) ?? 0) + delta);
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
              // Skip files outside the project directory
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
    result.push({
      path,
      operations: [...ops],
      lines_changed: fileLinesChanged.get(path) ?? 0,
    });
  }

  return result.slice(0, 20); // maxFilesTracked
}

/** Strings that look like errors but aren't */
const ERROR_FALSE_POSITIVES = [
  /^toolu_/,              // Tool use IDs
  /^#!\/usr\/bin/,        // Shebangs
  /^\d+→/,                // Line number prefixes from Read tool
  /^<retrieval_status>/,  // XML status tags
  /\.md\b/,               // Markdown file names
  /\.js\b.*\(toolu_/,     // File paths with tool IDs
];

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
    if (!text || text.length < 10) continue;

    if (ERROR_PATTERNS.some(p => p.test(text))) {
      // Extract first meaningful error line
      const firstLine = text.split('\n')[0]?.trim().slice(0, 200) ?? '';
      // Skip false positives
      if (ERROR_FALSE_POSITIVES.some(p => p.test(firstLine))) continue;
      // Skip very short matches (likely noise)
      if (firstLine.length < 15) continue;
      const key = firstLine.toLowerCase().slice(0, 50);

      if (!seen.has(key) && firstLine) {
        seen.add(key);
        errors.push({
          message: firstLine,
          tool: entry.tool_name,
          resolved: false,
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
  // Derive status from what was DONE, not from conversational text.
  // Look for the last user request to understand the task context.
  let lastUserRequest = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== 'user') continue;
    const text = getEntryText(entry);
    if (!text || text.length < 10) continue;
    // Skip very long user messages (likely pasted content)
    if (text.length > 500) continue;
    lastUserRequest = text.trim().slice(0, 150);
    break;
  }

  // Count recent tool actions for a factual summary
  const recentTools: Record<string, number> = {};
  const startIdx = Math.max(0, entries.length - 30);
  for (let i = startIdx; i < entries.length; i++) {
    if (entries[i].type === 'tool_use' && entries[i].tool_name) {
      const name = entries[i].tool_name!;
      recentTools[name] = (recentTools[name] ?? 0) + 1;
    }
  }

  const toolSummary = Object.entries(recentTools)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, c]) => `${t}(${c})`)
    .join(', ');

  if (lastUserRequest) {
    return `Last user direction: "${lastUserRequest}"${toolSummary ? `. Recent activity: ${toolSummary}` : ''}`;
  }

  return toolSummary ? `Recent activity: ${toolSummary}` : 'No status available';
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

// ─── User Sentiment ───

const POSITIVE_PATTERNS = [
  /\b(?:great|good|perfect|nice|awesome|excellent|looks good|well done|love it|thank|thanks)\b/i,
  /\b(?:works|working|fixed|solved|nailed it|ship it|lgtm)\b/i,
];

const NEGATIVE_PATTERNS = [
  /\b(?:wrong|broken|doesn't work|not what I|revert|undo|bad|terrible|hate)\b/i,
  /\b(?:no no|stop|don't|shouldn't have|why did you|that's not)\b/i,
];

function extractUserSentiment(entries: TranscriptEntry[]): 'positive' | 'neutral' | 'negative' {
  let positive = 0;
  let negative = 0;

  // Only look at recent user messages (last 30%)
  const startIdx = Math.floor(entries.length * 0.7);
  for (let i = startIdx; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type !== 'user') continue;
    const text = getEntryText(entry);
    if (!text) continue;

    if (POSITIVE_PATTERNS.some(p => p.test(text))) positive++;
    if (NEGATIVE_PATTERNS.some(p => p.test(text))) negative++;
  }

  if (positive > negative && positive >= 2) return 'positive';
  if (negative > positive && negative >= 2) return 'negative';
  return 'neutral';
}

// ─── Commit Gap Detection ───

export interface CommitGap {
  edits_since_commit: number;
  files_since_commit: number;
  last_commit_index: number;
}

/**
 * Detect how many file edits have happened since the last git commit.
 * If no commit is found, returns total edits.
 */
export function extractCommitGap(entries: TranscriptEntry[]): CommitGap {
  // Find the last git commit in the transcript
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

  // Count edits since that commit
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
