export interface HandoffPromptOptions {
  cwd: string;
  reason: string;
  /** Per-session destination: `<repo>/.bookmark/sessions/<sid>/handoff.md`. */
  handoffPath: string;
  sessionId: string;
  paneId?: string;
}

export const REQUIRED_HANDOFF_HEADINGS = [
  'Current task',
  'Status',
  'Remaining work',
  'Decisions',
  'Risks and open questions',
  'Sources of truth',
  'Next steps',
] as const;

/**
 * One compact semantic handoff contract shared by lifecycle and token hooks.
 * Mechanical snapshots remain CLI-owned; the running agent owns the semantic
 * summary because transcript heuristics cannot reliably infer decisions.
 */
export function buildHandoffPrompt(options: HandoffPromptOptions): string {
  return [
    options.reason,
    `Write or replace ${options.handoffPath} now. This file belongs to this session only.`,
    `Start with BOOKMARK_IDENTITY: scope repo, project, absolute repo_path, branch, head, ISO written date, session_id: ${options.sessionId}, and pane: ${options.paneId ?? 'none'}.`,
    `Use these headings: ${REQUIRED_HANDOFF_HEADINGS.map(heading => `## ${heading}`).join('; ')}.`,
    'State completed, validated, committed, pushed, and deployed work separately. Include exact validation results.',
    'For every pending check, give the exact command to run it.',
    'Use absolute file paths in Sources of truth and Next steps. Point to durable files instead of copying long content.',
    'Record unknowns explicitly. Write "None known" when a risk or question section is empty.',
    'Keep the handoff under 800 tokens. Preserve enough detail for a cold session to resume without guessing.',
  ].join('\n');
}
