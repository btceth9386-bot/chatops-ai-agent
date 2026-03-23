import type { ResponseMode } from '../types';

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
  constructor(private readonly client: SlackClientLike) {}

  private resolveChannel(target: SlackStreamTarget): string {
    return target.responseMode === 'publish_channel' ? target.publishChannelId ?? target.channelId : target.channelId;
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
    await this.client.chat.update({
      channel: this.resolveChannel(target),
      ts: statusMessageTs,
      text: text.trim() || 'Working on it…',
    });
  }

  async complete(target: SlackStreamTarget, statusMessageTs: string, text: string): Promise<void> {
    await this.client.chat.update({
      channel: this.resolveChannel(target),
      ts: statusMessageTs,
      text: text.trim() || 'Done.',
    });
  }

  async fail(target: SlackStreamTarget, statusMessageTs: string, error: string): Promise<void> {
    await this.client.chat.update({
      channel: this.resolveChannel(target),
      ts: statusMessageTs,
      text: `ACP request failed: ${error}`,
    });
  }
}
