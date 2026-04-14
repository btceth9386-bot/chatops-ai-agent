import type { ReactionsConfig } from '../types';

export interface SlackReactionClientLike {
  reactions: {
    add(args: Record<string, unknown>): Promise<unknown>;
    remove(args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface SlackReactionTarget {
  channelId: string;
  messageTs: string;
}

function classifyToolEmoji(toolName: string, config: ReactionsConfig): string {
  const name = toolName.toLowerCase();

  if (/(web_search|web_fetch|browser)/.test(name)) {
    return config.emojis.web;
  }

  if (/(exec|process|read|write|edit|bash|shell)/.test(name)) {
    return config.emojis.coding;
  }

  return config.emojis.tool;
}

export class SlackReactionController {
  private currentEmoji?: string;
  private pendingEmoji?: string;
  private pendingTimer?: NodeJS.Timeout;
  private stallSoftTimer?: NodeJS.Timeout;
  private stallHardTimer?: NodeJS.Timeout;
  private clearTimer?: NodeJS.Timeout;
  private operationQueue = Promise.resolve();

  constructor(
    private readonly client: SlackReactionClientLike,
    private readonly target: SlackReactionTarget,
    private readonly config: ReactionsConfig
  ) {}

  async setQueued(): Promise<void> {
    this.bumpActivity();
    await this.applyEmoji(this.config.emojis.queued);
  }

  async setThinking(): Promise<void> {
    this.bumpActivity();
    await this.scheduleEmoji(this.config.emojis.thinking);
  }

  async setTool(toolName: string): Promise<void> {
    this.bumpActivity();
    await this.scheduleEmoji(classifyToolEmoji(toolName, this.config));
  }

  async setDone(): Promise<void> {
    this.cancelPendingTimers();
    await this.applyEmoji(this.config.emojis.done);
    this.scheduleClear(this.config.timing.doneHoldMs);
  }

  async setError(): Promise<void> {
    this.cancelPendingTimers();
    await this.applyEmoji(this.config.emojis.error);
    this.scheduleClear(this.config.timing.errorHoldMs);
  }

  async clear(): Promise<void> {
    this.cancelPendingTimers();
    await this.enqueue(async () => {
      if (!this.currentEmoji) {
        return;
      }

      await this.client.reactions.remove({
        channel: this.target.channelId,
        timestamp: this.target.messageTs,
        name: this.currentEmoji,
      });
      this.currentEmoji = undefined;
    });
  }

  private async scheduleEmoji(emoji: string): Promise<void> {
    if (this.currentEmoji === emoji || this.pendingEmoji === emoji) {
      return;
    }

    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }

    this.pendingEmoji = emoji;
    await new Promise<void>((resolve) => {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = undefined;
        this.pendingEmoji = undefined;
        void this.applyEmoji(emoji).finally(resolve);
      }, this.config.timing.debounceMs);
    });
  }

  private bumpActivity(): void {
    if (!this.config.enabled) {
      return;
    }

    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = undefined;
    }

    if (this.stallSoftTimer) {
      clearTimeout(this.stallSoftTimer);
    }
    if (this.stallHardTimer) {
      clearTimeout(this.stallHardTimer);
    }

    this.stallSoftTimer = setTimeout(() => {
      void this.applyEmoji(this.config.emojis.stallSoft);
    }, this.config.timing.stallSoftMs);

    this.stallHardTimer = setTimeout(() => {
      void this.applyEmoji(this.config.emojis.stallHard);
    }, this.config.timing.stallHardMs);
  }

  private cancelPendingTimers(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.pendingEmoji = undefined;

    if (this.stallSoftTimer) {
      clearTimeout(this.stallSoftTimer);
      this.stallSoftTimer = undefined;
    }
    if (this.stallHardTimer) {
      clearTimeout(this.stallHardTimer);
      this.stallHardTimer = undefined;
    }
  }

  private scheduleClear(delayMs: number): void {
    if (!this.config.removeAfterReply) {
      return;
    }

    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
    }

    this.clearTimer = setTimeout(() => {
      this.clearTimer = undefined;
      void this.clear();
    }, delayMs);
  }

  private async applyEmoji(emoji: string): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await this.enqueue(async () => {
      if (this.currentEmoji === emoji) {
        return;
      }

      if (this.currentEmoji) {
        await this.client.reactions.remove({
          channel: this.target.channelId,
          timestamp: this.target.messageTs,
          name: this.currentEmoji,
        });
      }

      await this.client.reactions.add({
        channel: this.target.channelId,
        timestamp: this.target.messageTs,
        name: emoji,
      });
      this.currentEmoji = emoji;
    });
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.operationQueue
      .catch(() => {
        // Keep the queue alive even if a prior Slack API call failed.
      })
      .then(work);

    this.operationQueue = next;
    await next;
  }
}
