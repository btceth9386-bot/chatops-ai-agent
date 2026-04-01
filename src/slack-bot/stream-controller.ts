import type { ResponseMode } from '../types';
import { splitSlackMessage } from './response-formatter';

const SLACK_MAX_BYTES = 3900;

/** Truncate text so its UTF-8 byte length stays within `maxBytes`. */
function truncateToBytes(text: string, maxBytes: number, suffix = ''): string {
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const limit = maxBytes - suffixBytes;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Binary-search for the right char index
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= limit) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + suffix;
}

export interface SlackClientLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<{ ts?: string }>;
  };
}

export interface SlackStreamTarget {
  channelId: string;
  threadTs: string;
  responseMode: ResponseMode;
  publishChannelId?: string;
}

export class SlackStreamController {
  private readonly updateQueues = new Map<string, Promise<void>>();
  private readonly latestTexts = new Map<string, string>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private static readonly UPDATE_THROTTLE_MS = 900;

  constructor(private readonly client: SlackClientLike) {}

  private resolveChannel(target: SlackStreamTarget): string {
    return target.responseMode === 'publish_channel' ? target.publishChannelId ?? target.channelId : target.channelId;
  }

  private queueKey(channel: string, statusMessageTs: string): string {
    return `${channel}:${statusMessageTs}`;
  }

  private async enqueueUpdate(channel: string, statusMessageTs: string, work: () => Promise<void>): Promise<void> {
    const key = this.queueKey(channel, statusMessageTs);
    const previous = this.updateQueues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep the queue alive even if an earlier update failed.
      })
      .then(work);

    this.updateQueues.set(key, current);

    try {
      await current;
    } finally {
      if (this.updateQueues.get(key) === current) {
        this.updateQueues.delete(key);
      }
    }
  }

  private clearPendingFlush(key: string): void {
    const timer = this.flushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(key);
    }
  }

  private scheduleFlush(channel: string, statusMessageTs: string): void {
    const key = this.queueKey(channel, statusMessageTs);
    if (this.flushTimers.has(key)) {
      return;
    }

    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      const text = this.latestTexts.get(key);
      if (typeof text !== 'string') {
        return;
      }

      void this.enqueueUpdate(channel, statusMessageTs, async () => {
        await this.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: text.trim() || 'Working on it…',
        });
      });
    }, SlackStreamController.UPDATE_THROTTLE_MS);

    this.flushTimers.set(key, timer);
  }

  async ensurePlaceholder(target: SlackStreamTarget, statusMessageTs?: string): Promise<string> {
    if (statusMessageTs) {
      return statusMessageTs;
    }

    const response = await this.client.chat.postMessage({
      channel: this.resolveChannel(target),
      thread_ts: target.threadTs,
      text: 'Working on it…',
    });

    return response.ts ?? target.threadTs;
  }

  async pushDelta(target: SlackStreamTarget, statusMessageTs: string, text: string): Promise<void> {
    const channel = this.resolveChannel(target);
    const key = this.queueKey(channel, statusMessageTs);
    const truncated = truncateToBytes(text, SLACK_MAX_BYTES, '\n…(streaming)');
    this.latestTexts.set(key, truncated);
    this.scheduleFlush(channel, statusMessageTs);
  }

  async complete(target: SlackStreamTarget, statusMessageTs: string, text: string): Promise<void> {
    const channel = this.resolveChannel(target);
    const key = this.queueKey(channel, statusMessageTs);
    this.clearPendingFlush(key);
    this.latestTexts.delete(key);

    const parts = splitSlackMessage(text.trim() || 'Done.', SLACK_MAX_BYTES);
    await this.enqueueUpdate(channel, statusMessageTs, async () => {
      await this.client.chat.update({
        channel,
        ts: statusMessageTs,
        text: parts[0],
      });
      for (let i = 1; i < parts.length; i++) {
        await this.client.chat.postMessage({
          channel,
          thread_ts: target.threadTs,
          text: parts[i],
        });
      }
    });
  }

  async fail(target: SlackStreamTarget, statusMessageTs: string, error: string): Promise<void> {
    const channel = this.resolveChannel(target);
    const key = this.queueKey(channel, statusMessageTs);
    this.clearPendingFlush(key);
    this.latestTexts.delete(key);
    // Never expose stack traces or internal details to Slack users
    const safeError = error.includes('\n') ? error.split('\n')[0] : error;
    const display = safeError.length > 200 ? safeError.slice(0, 200) + '…' : safeError;
    await this.enqueueUpdate(channel, statusMessageTs, async () => {
      await this.client.chat.update({
        channel,
        ts: statusMessageTs,
        text: `⚠️ Request failed: ${display}`,
      });
    });
  }
}
