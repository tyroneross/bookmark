import { describe, expect, it } from 'vitest';
import { buildHandoffPrompt } from './handoff-prompt.js';

describe('buildHandoffPrompt', () => {
  it('requires the continuity fields a cold session needs while staying compact', () => {
    const prompt = buildHandoffPrompt({ cwd: '/tmp/example-repo', reason: 'Threshold crossed.' });

    expect(prompt).toContain('/tmp/example-repo/.bookmark/bookmark.context.md');
    expect(prompt).toContain('BOOKMARK_IDENTITY');
    expect(prompt).toContain('Current task');
    expect(prompt).toContain('Status');
    expect(prompt).toContain('Remaining work');
    expect(prompt).toContain('Decisions');
    expect(prompt).toContain('Risks and open questions');
    expect(prompt).toContain('Sources of truth');
    expect(prompt).toContain('Next steps');
    expect(prompt).toContain('under 800 tokens');
    expect(prompt.length).toBeLessThan(1_200);
  });
});
