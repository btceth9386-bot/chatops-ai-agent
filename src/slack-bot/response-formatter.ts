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

export function splitSlackMessage(text: string, limitBytes = SLACK_MESSAGE_LIMIT): string[] {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) {
    return [text];
  }

  const parts: string[] = [];
  let remaining = text;

  while (Buffer.byteLength(remaining, 'utf8') > limitBytes) {
    // Find a char-index whose byte length is close to limitBytes
    let hi = Math.min(remaining.length, limitBytes);
    while (hi > 0 && Buffer.byteLength(remaining.slice(0, hi), 'utf8') > limitBytes) {
      hi -= Math.max(1, Math.floor(hi / 10));
    }
    const candidate = remaining.slice(0, hi);
    const splitAt = Math.max(candidate.lastIndexOf('\n\n'), candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    const boundary = splitAt > Math.floor(hi * 0.5) ? splitAt : hi;

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
