import type { SlackEvent } from '../types';
import { sanitizeInput } from './sanitizer';
import type { RoutingLayer } from './routing';
import type { CloudWatchLogger } from '../logging/cloudwatch';

interface SlackEventLike {
  text?: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  user: string;
}

export function toSlackEvent(
  event: SlackEventLike,
  type: 'app_mention' | 'message',
  maxLength = 10000
): SlackEvent {
  const sanitized = sanitizeInput(event.text ?? '', maxLength);
  const threadTs = event.thread_ts ?? event.ts;

  return {
    type,
    messageText: sanitized.text,
    channelId: event.channel,
    threadTs,
    userId: event.user,
    timestamp: event.ts,
  };
}

export async function handleSlackEvent(
  event: SlackEvent,
  routing: RoutingLayer,
  logger: CloudWatchLogger
): Promise<void> {
  const decision = routing.decide(event);

  switch (decision.action) {
    case 'ignore':
      await logger.logInfo('Ignoring Slack event', {
        component: 'events',
        reason: decision.reason,
        channelId: event.channelId,
        threadTs: event.threadTs,
        userId: event.userId,
      });
      return;
    case 'learning':
      await routing.spawnLearningInvestigation(event);
      await logger.logInfo('Spawned learning investigation', {
        component: 'events',
        channelId: event.channelId,
        threadTs: event.threadTs,
      });
      return;
    case 'escalate':
      await logger.logInfo('Escalation requested', {
        component: 'events',
        channelId: event.channelId,
        threadTs: event.threadTs,
        userId: event.userId,
      });
      return;
    case 'acp_prompt':
      await logger.logInfo('ACP prompt requested', {
        component: 'events',
        channelId: event.channelId,
        threadTs: event.threadTs,
        userId: event.userId,
      });
      return;
  }
}

