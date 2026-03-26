import { describe, expect, it } from 'vitest';
import { buildSlackResponse, formatSafeSummary, splitSlackMessage } from '../../src/slack-bot/response-formatter';
import type { SafeSummary } from '../../src/types';

const summary: SafeSummary = {
  findings: 'API latency increased after the last deploy.',
  hypotheses: ['The new database query plan is slower.', 'A dependency retry loop is amplifying load.'],
  recommendedActions: ['Compare query plans before and after deploy.', 'Check retry volume in application logs.'],
  totalLength: 180,
};

describe('response formatter', () => {
  it('formats a safe summary into Slack mrkdwn', () => {
    const text = formatSafeSummary(summary);

    expect(text).toContain('*Findings*');
    expect(text).toContain('*Hypotheses*');
    expect(text).toContain('*Recommended actions*');
  });

  it('splits oversized Slack messages', () => {
    const parts = splitSlackMessage('a'.repeat(6500), 3000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 3000)).toBe(true);
  });

  it('adds source permalink for publish_channel mode', () => {
    const response = buildSlackResponse(summary, 'publish_channel', 'https://slack.com/archives/C1/p123');

    expect(response.messages[0]).toContain('Source thread');
    expect(response.messages[0]).toContain('https://slack.com/archives/C1/p123');
  });
});
