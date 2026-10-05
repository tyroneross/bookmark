import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../util/atomic-write.js';
import {
  LEGACY_LINEAGE_KEY,
  getLineageDir,
  getLineagePath,
  getSessionHandoffPath,
  getSessionsDir,
  lineageKey,
} from './paths.js';

/** First line of the generated repo-level index. Never treat such a file as a handoff. */
export const INDEX_MARKER = '<!-- BOOKMARK_INDEX generated -->';

export interface LineageRecord {
  key: string;
  session_id: string;
  pane: string | null;
  pid: string | null;
  handoff_path: string;
  sha256: string;
  head: string | null;
  sealed_at: string;
}

/** C4: sha256 over the exact file bytes, lowercase hex. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function currentGitHead(cwd: string): string | null {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return head || null;
  } catch {
    return null;
  }
}

export function isGeneratedIndex(content: string): boolean {
  return content.startsWith(INDEX_MARKER);
}

/** C5 verify line, verbatim. */
export function verifyLine(path: string, sha: string): string {
  return `Verify first: \`shasum -a 256 '${path}'\` must print ${sha}. If it differs or the file is missing, stop and ask the owner; do not act on it.`;
}

/** C5 kickoff text: absolute path, hash, verify line. */
export function buildKickoff(record: Pick<LineageRecord, 'handoff_path' | 'sha256'>): string {
  return [
    `Resume from the handoff at ${record.handoff_path}`,
    `sha256: ${record.sha256}`,
    verifyLine(record.handoff_path, record.sha256),
  ].join('\n');
}

export interface SealOptions {
  storagePath: string;
  cwd: string;
  sessionId: string;
  paneId?: string;
  pid?: string;
  /** Injected for tests; defaults to `git rev-parse HEAD` in cwd. */
  head?: string | null;
  now?: Date;
}

/**
 * A3: hash this session's handoff, point its lineage key at it, and regenerate
 * the repo-level index. Returns null when the session has no handoff file.
 */
export function sealHandoff(options: SealOptions): LineageRecord | null {
  const handoffPath = getSessionHandoffPath(options.storagePath, options.sessionId);
  if (!existsSync(handoffPath)) return null;
  const key = lineageKey({ paneId: options.paneId, pid: options.pid, sessionId: options.sessionId })!;
  const record = writeLineage(options.storagePath, {
    key,
    session_id: options.sessionId,
    pane: options.paneId ?? null,
    pid: options.pid ?? null,
    handoff_path: handoffPath,
    head: options.head !== undefined ? options.head : currentGitHead(options.cwd),
    now: options.now,
  });
  writeHandoffIndex(options.storagePath, options.now);
  return record;
}

function writeLineage(
  storagePath: string,
  fields: Omit<LineageRecord, 'sha256' | 'sealed_at'> & { now?: Date }
): LineageRecord {
  const { now, ...rest } = fields;
  const record: LineageRecord = {
    ...rest,
    sha256: sha256File(fields.handoff_path),
    sealed_at: (now ?? new Date()).toISOString(),
  };
  writeFileAtomic(getLineagePath(storagePath, record.key), JSON.stringify(record, null, 2));
  return record;
}

/**
 * Before the first generated index replaces it, move an agent-written
 * pre-upgrade `bookmark.context.md` to `sessions/legacy/handoff.md` (atomic
 * rename, never deleted) and seal it under the `legacy` key. That key is
 * listed in the index but never matches a pane, pid or session lookup.
 */
export function migrateLegacyContextMd(storagePath: string, now = new Date()): LineageRecord | null {
  const contextPath = join(storagePath, 'bookmark.context.md');
  try {
    if (isGeneratedIndex(readFileSync(contextPath, 'utf-8'))) return null;
  } catch {
    return null;
  }

  // Claim the file with one atomic rename so two sessions cannot both move it;
  // re-check after the claim in case another session already replaced it with an index.
  const legacyDir = join(getSessionsDir(storagePath), 'legacy');
  mkdirSync(legacyDir, { recursive: true });
  const claimed = join(legacyDir, `.claim.${process.pid}.${now.getTime()}.md`);
  try {
    renameSync(contextPath, claimed);
  } catch {
    return null;
  }
  if (isGeneratedIndex(readFileSync(claimed, 'utf-8'))) {
    try { unlinkSync(claimed); } catch { /* generated file; regenerated below */ }
    return null;
  }
  let destination = join(legacyDir, 'handoff.md');
  if (existsSync(destination)) {
    destination = join(legacyDir, `handoff.${now.toISOString().replace(/[:.]/g, '-')}.md`);
  }
  renameSync(claimed, destination);
  return writeLineage(storagePath, {
    key: LEGACY_LINEAGE_KEY,
    session_id: 'legacy',
    pane: null,
    pid: null,
    handoff_path: destination,
    head: null,
    now,
  });
}

/** Newest record written by a session, whatever key it was sealed under. */
export function findLineageBySession(storagePath: string, sessionId: string): LineageRecord | null {
  return listLineage(storagePath).find(record => record.session_id === sessionId) ?? null;
}

export function readLineage(storagePath: string, key: string): LineageRecord | null {
  return parseRecord(getLineagePath(storagePath, key));
}

/** Every lineage pointer whose handoff file still exists, newest first. */
export function listLineage(storagePath: string): LineageRecord[] {
  const dir = getLineageDir(storagePath);
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    return [];
  }
  return names
    .map(name => parseRecord(join(dir, name)))
    .filter((record): record is LineageRecord => record !== null && existsSync(record.handoff_path))
    .sort((a, b) => b.sealed_at.localeCompare(a.sealed_at));
}

export function buildHandoffIndex(storagePath: string, now = new Date()): string {
  const records = listLineage(storagePath);
  const lines = [
    INDEX_MARKER,
    '# Bookmark handoff index',
    '',
    `Generated ${now.toISOString()}. This file is an index, not a handoff.`,
    'Each session writes its own handoff; resume only from the one linked to your pane or session,',
    'and verify its sha256 before acting on it.',
    '',
  ];
  if (records.length === 0) {
    lines.push('No sealed handoffs.');
  }
  for (const record of records) {
    lines.push(
      `- ${record.sealed_at} (${formatAge(now.getTime() - Date.parse(record.sealed_at))} ago) ` +
      `${record.key} · session ${record.session_id} · pane ${record.pane ?? 'none'} · sha256 ${record.sha256}`,
      `  ${record.handoff_path}`
    );
  }
  return lines.join('\n') + '\n';
}

export function writeHandoffIndex(storagePath: string, now = new Date()): void {
  migrateLegacyContextMd(storagePath, now);
  writeFileAtomic(join(storagePath, 'bookmark.context.md'), buildHandoffIndex(storagePath, now));
}

export interface VerifyResult {
  ok: boolean;
  actual: string | null;
  reason?: 'missing' | 'mismatch';
}

export function verifyHandoff(path: string, expectedSha: string): VerifyResult {
  if (!existsSync(path)) return { ok: false, actual: null, reason: 'missing' };
  const actual = sha256File(path);
  return actual === expectedSha.trim().toLowerCase()
    ? { ok: true, actual }
    : { ok: false, actual, reason: 'mismatch' };
}

function parseRecord(path: string): LineageRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LineageRecord>;
    if (
      typeof parsed.session_id !== 'string' ||
      typeof parsed.handoff_path !== 'string' ||
      typeof parsed.sha256 !== 'string' ||
      typeof parsed.sealed_at !== 'string'
    ) {
      return null;
    }
    return {
      key: parsed.key ?? lineageKey({
        paneId: parsed.pane ?? undefined,
        pid: parsed.pid ?? undefined,
        sessionId: parsed.session_id,
      })!,
      session_id: parsed.session_id,
      pane: parsed.pane ?? null,
      pid: parsed.pid ?? null,
      handoff_path: parsed.handoff_path,
      sha256: parsed.sha256,
      head: parsed.head ?? null,
      sealed_at: parsed.sealed_at,
    };
  } catch {
    return null;
  }
}

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
