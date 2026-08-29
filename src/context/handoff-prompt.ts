import { join } from 'node:path';

export interface HandoffPromptOptions {
  cwd: string;
  reason: string;
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
  const destination = join(options.cwd, '.bookmark', 'bookmark.context.md');
  return [
    options.reason,
    `Write or replace ${destination} now.`,
    'Start with BOOKMARK_IDENTITY: scope repo, project, absolute repo_path, branch, head, and ISO written date.',
    `Use these headings: ${REQUIRED_HANDOFF_HEADINGS.map(heading => `## ${heading}`).join('; ')}.`,
    'State completed, validated, committed, pushed, and deployed work separately. Include exact validation results.',
    'Use absolute file paths in Sources of truth and Next steps. Point to durable files instead of copying long content.',
    'Record unknowns explicitly. Write "None known" when a risk or question section is empty.',
    'Keep the handoff under 800 tokens. Preserve enough detail for a cold session to resume without guessing.',
  ].join('\n');
}
