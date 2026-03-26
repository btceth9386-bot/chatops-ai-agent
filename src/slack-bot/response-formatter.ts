import { SafeSummary, ResponseMode } from '../types';

const SLACK_MESSAGE_LIMIT = 3000;

export interface FormattedSlackResponse {
  mode: ResponseMode;
  messages: string[];
}

function compactLines(lines: Array<string | undefined | false>): string {
  return lines.filter(Boolean).join('\n').trim();
}

export function formatSafeSummary(summary: SafeSummary): string {
  const findings = summary.findings.trim();
  const hypotheses = summary.hypotheses.map((item) => `• ${item}`).join('\n');
  const actions = summary.recommendedActions.map((item) => `• ${item}`).join('\n');

  return compactLines([
    '*Findings*',
    findings,
    summary.hypotheses.length > 0 && '',
    summary.hypotheses.length > 0 && '*Hypotheses*',
    hypotheses,
    summary.recommendedActions.length > 0 && '',
    summary.recommendedActions.length > 0 && '*Recommended actions*',
    actions,
  ]);
}

export function splitSlackMessage(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const splitAt = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const boundary = splitAt > Math.floor(limit * 0.5) ? splitAt : limit;

    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

export function buildSlackResponse(
  summary: SafeSummary,
  mode: ResponseMode,
  permalink?: string
): FormattedSlackResponse {
  const base = formatSafeSummary(summary);
  const text =
    mode === 'publish_channel' && permalink
      ? `*Source thread:* ${permalink}\n\n${base}`
      : base;

  return {
    mode,
    messages: splitSlackMessage(text),
  };
}
