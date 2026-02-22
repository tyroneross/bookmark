import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot, Decision, FileActivity } from '../types.js';

/**
 * Trail-routed memory writer.
 *
 * Writes two tiers of context:
 * 1. CONTEXT.md — trailhead (~400 tokens), always injected on restore
 * 2. trails/ — detail files the LLM can Read if it needs more
 *
 * Each capture updates trails incrementally:
 * - Decisions get appended with timestamps, newer same-topic overrides older
 * - Files get merged (union by path, latest operations win)
 * - CONTEXT.md gets rewritten with current state + routing pointers
 */

// ─── Public API ───

export function writeTrails(storagePath: string, snapshot: Snapshot): void {
  const trailsDir = ensureTrailsDir(storagePath);

  // Write detail trails first (they inform CONTEXT.md routing)
  const decisionStats = writeDecisionTrail(trailsDir, snapshot);
  const fileStats = writeFileTrail(trailsDir, snapshot);

  // Write trailhead last — it references the trails
  writeContextMd(storagePath, snapshot, trailsDir, { decisionStats, fileStats });
}

// ─── CONTEXT.md (Trailhead) ───

interface TrailStats {
  decisionStats: { active: number; superseded: number };
  fileStats: { count: number; totalLines: number };
}

function writeContextMd(
  storagePath: string,
  snapshot: Snapshot,
  trailsDir: string,
  stats: TrailStats
): void {
  const lines: string[] = [];
  const projectName = snapshot.project_path.split('/').pop() ?? 'project';
  const ts = new Date(snapshot.timestamp).toISOString().slice(0, 16) + 'Z';

  lines.push(`[Bookmark Context — ${projectName}]`);
  lines.push(`> Updated: ${ts} | Cycle: ${snapshot.compaction_cycle}`);
  lines.push('');

  // Intent — THE most important line
  if (snapshot.intent && snapshot.intent !== 'Unknown') {
    lines.push(`**Intent:** ${snapshot.intent}`);
  }

  // Progress
  if (snapshot.progress && snapshot.progress !== 'Unknown') {
    lines.push(`**Progress:** ${snapshot.progress}`);
  }

  // Sentiment
  if (snapshot.user_sentiment && snapshot.user_sentiment !== 'neutral') {
    lines.push(`**User feedback:** ${snapshot.user_sentiment}`);
  }

  lines.push('');

  // Routing table — tells the LLM where to find deeper context
  lines.push('**Trails** (use Read tool if you need more detail):');

  if (stats.decisionStats.active > 0) {
    lines.push(`- \`${trailsDir}/decisions.md\` — ${stats.decisionStats.active} active decisions${stats.decisionStats.superseded > 0 ? `, ${stats.decisionStats.superseded} superseded` : ''}`);
  }
  if (stats.fileStats.count > 0) {
    lines.push(`- \`${trailsDir}/files.md\` — ${stats.fileStats.count} files, ~${stats.fileStats.totalLines} lines changed`);
  }

  lines.push('');

  // Remaining items — always in trailhead (these are actionable)
  if (snapshot.open_items.length > 0) {
    lines.push('**Remaining:**');
    for (const item of snapshot.open_items.slice(0, 4)) {
      lines.push(`- ${item.description.slice(0, 120)}`);
    }
    lines.push('');
  }

  lines.push('Resume the task above. Follow trail links only if you need specifics.');

  writeFileSync(join(storagePath, 'CONTEXT.md'), lines.join('\n'), 'utf-8');
}

// ─── Decision Trail ───

interface DecisionEntry {
  timestamp: string;
  topic: string;
  description: string;
  rationale?: string;
  status: 'active' | 'superseded';
  superseded_by?: string;
}

function writeDecisionTrail(
  trailsDir: string,
  snapshot: Snapshot
): { active: number; superseded: number } {
  const trailPath = join(trailsDir, 'decisions.md');

  // Load existing decisions
  let existing = loadDecisionEntries(trailPath);

  // Add new decisions from this snapshot
  const ts = new Date(snapshot.timestamp).toISOString().slice(0, 16) + 'Z';
  for (const d of snapshot.decisions) {
    const topic = deriveTopic(d.description);
    const entry: DecisionEntry = {
      timestamp: ts,
      topic,
      description: d.description,
      rationale: d.rationale,
      status: 'active',
    };

    // Check for same-topic override
    const existingIdx = existing.findIndex(
      e => e.topic === topic && e.status === 'active'
    );
    if (existingIdx >= 0) {
      // Supersede the old one
      existing[existingIdx].status = 'superseded';
      existing[existingIdx].superseded_by = ts;
    }

    existing.push(entry);
  }

  // Deduplicate: if we have exact same description, skip
  existing = deduplicateDecisions(existing);

  // Write the trail file
  const active = existing.filter(e => e.status === 'active');
  const superseded = existing.filter(e => e.status === 'superseded');

  const lines: string[] = [];
  lines.push('# Decision Trail');
  lines.push('> Newer decisions override older on the same topic. [SUPERSEDED] entries kept for context.');
  lines.push('');

  if (active.length > 0) {
    lines.push('## Active');
    for (const d of active) {
      lines.push('');
      lines.push(`### [${d.timestamp}] ${d.description.slice(0, 100)}`);
      if (d.rationale) {
        lines.push(`Rationale: ${d.rationale.slice(0, 150)}`);
      }
    }
    lines.push('');
  }

  if (superseded.length > 0) {
    lines.push('## Superseded');
    for (const d of superseded) {
      lines.push(`- ~~${d.description.slice(0, 80)}~~ → replaced ${d.superseded_by ?? ''}`);
    }
    lines.push('');
  }

  writeFileSync(trailPath, lines.join('\n'), 'utf-8');

  return { active: active.length, superseded: superseded.length };
}

/**
 * Derive a topic key from a decision description.
 * Used for same-topic override detection.
 * Takes the first 4 significant words, lowercased.
 */
function deriveTopic(description: string): string {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'of',
    'in', 'on', 'at', 'by', 'with', 'from', 'that', 'this', 'it',
    'and', 'or', 'but', 'not', 'be', 'has', 'have', 'had', 'do', 'does',
    'use', 'using', 'used',
  ]);
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  return words.slice(0, 4).join('_') || 'misc';
}

function loadDecisionEntries(trailPath: string): DecisionEntry[] {
  if (!existsSync(trailPath)) return [];

  try {
    const content = readFileSync(trailPath, 'utf-8');
    const entries: DecisionEntry[] = [];

    // Parse the markdown back into entries
    let currentStatus: 'active' | 'superseded' = 'active';
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.startsWith('## Active')) {
        currentStatus = 'active';
        continue;
      }
      if (line.startsWith('## Superseded')) {
        currentStatus = 'superseded';
        continue;
      }

      if (currentStatus === 'active' && line.startsWith('### [')) {
        const tsMatch = line.match(/### \[([^\]]+)\] (.+)/);
        if (tsMatch) {
          entries.push({
            timestamp: tsMatch[1],
            topic: deriveTopic(tsMatch[2]),
            description: tsMatch[2],
            status: 'active',
          });
        }
      }

      if (currentStatus === 'superseded' && line.startsWith('- ~~')) {
        const match = line.match(/- ~~(.+?)~~ → replaced (.+)/);
        if (match) {
          entries.push({
            timestamp: '',
            topic: deriveTopic(match[1]),
            description: match[1],
            status: 'superseded',
            superseded_by: match[2],
          });
        }
      }
    }

    return entries;
  } catch {
    return [];
  }
}

function deduplicateDecisions(entries: DecisionEntry[]): DecisionEntry[] {
  const seen = new Set<string>();
  const result: DecisionEntry[] = [];
  // Walk backward so newest entries win dedup
  for (let i = entries.length - 1; i >= 0; i--) {
    const key = entries[i].description.slice(0, 60).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.unshift(entries[i]);
    }
  }
  return result;
}

// ─── File Trail ───

function writeFileTrail(
  trailsDir: string,
  snapshot: Snapshot
): { count: number; totalLines: number } {
  const trailPath = join(trailsDir, 'files.md');

  // Load existing file entries and merge with new
  const fileMap = loadFileEntries(trailPath);

  for (const f of snapshot.files_changed) {
    const shortPath = f.path.startsWith(snapshot.project_path)
      ? f.path.slice(snapshot.project_path.length).replace(/^\//, '')
      : f.path;

    const existing = fileMap.get(shortPath);
    if (existing) {
      const ops = new Set([...existing.operations, ...f.operations]);
      existing.operations = [...ops];
      // Use max, not sum — same transcript produces same totals across snapshots
      existing.lines_changed = Math.max(existing.lines_changed ?? 0, f.lines_changed ?? 0);
    } else {
      fileMap.set(shortPath, {
        path: shortPath,
        operations: [...f.operations],
        lines_changed: f.lines_changed,
      });
    }
  }

  // Sort by lines changed descending
  const files = [...fileMap.values()].sort(
    (a, b) => (b.lines_changed ?? 0) - (a.lines_changed ?? 0)
  );

  const totalLines = files.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);

  const lines: string[] = [];
  lines.push('# File Trail');
  lines.push(`> ${files.length} files, ~${totalLines} lines changed total`);
  lines.push('');

  for (const f of files) {
    const lc = f.lines_changed ? ` ~${f.lines_changed}L` : '';
    lines.push(`- \`${f.path}\` (${f.operations.join('/')}${lc})`);
  }

  writeFileSync(trailPath, lines.join('\n'), 'utf-8');

  return { count: files.length, totalLines };
}

function loadFileEntries(trailPath: string): Map<string, FileActivity> {
  if (!existsSync(trailPath)) return new Map();

  try {
    const content = readFileSync(trailPath, 'utf-8');
    const fileMap = new Map<string, FileActivity>();

    for (const line of content.split('\n')) {
      // Parse: - `src/foo.ts` (edit/write ~123L)
      const match = line.match(/^- `(.+?)` \(([^)]+)\)/);
      if (match) {
        const path = match[1];
        const opsStr = match[2];
        const ops = opsStr.replace(/\s*~\d+L/, '').split('/') as FileActivity['operations'];
        const lcMatch = opsStr.match(/~(\d+)L/);
        const linesChanged = lcMatch ? parseInt(lcMatch[1], 10) : undefined;
        fileMap.set(path, { path, operations: ops, lines_changed: linesChanged });
      }
    }

    return fileMap;
  } catch {
    return new Map();
  }
}

// ─── Helpers ───

function ensureTrailsDir(storagePath: string): string {
  const trailsDir = join(storagePath, 'trails');
  if (!existsSync(trailsDir)) {
    mkdirSync(trailsDir, { recursive: true });
  }
  return trailsDir;
}
