import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChannelConfig, SlackEvent } from '../types';
import type { LoadedConfig } from '../config/manager';

export interface RoutingDecision {
  action: 'ignore' | 'learning' | 'acp_prompt' | 'escalate' | 'de_escalate';
  reason: string;
  channel?: ChannelConfig;
}

export interface LearningCommandResult {
  command: string;
  logPath: string;
}

export class RoutingLayer {
  private config: LoadedConfig;

  constructor(config: LoadedConfig) {
    this.config = config;
  }

  updateConfig(config: LoadedConfig): void {
    this.config = config;
  }

  isChannelAllowed(channelId: string): boolean {
    return this.getChannelConfig(channelId) !== null;
  }

  getChannelConfig(channelId: string): ChannelConfig | null {
    return (
      this.config.channelAllowlist.find((channel) => channel.channelId === channelId && channel.enabled !== false) ?? null
    );
  }

  private stripMention(text: string): string {
    return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
  }

  isEscalationCommand(text: string): boolean {
    return /^(escalate|\/escalate|\/architect)$/i.test(this.stripMention(text));
  }

  isDeescalationCommand(text: string): boolean {
    return /^(de-escalate|\/de-escalate|\/senior)$/i.test(this.stripMention(text));
  }

  decide(event: SlackEvent): RoutingDecision {
    const channel = this.getChannelConfig(event.channelId);
    if (!channel) {
      return { action: 'ignore', reason: 'channel_not_allowed' };
    }

    if (this.isEscalationCommand(event.messageText)) {
      return { action: 'escalate', reason: 'explicit_human_escalation', channel };
    }

    if (this.isDeescalationCommand(event.messageText)) {
      return { action: 'de_escalate', reason: 'explicit_human_deescalation', channel };
    }

    if (channel.mode === 'learning') {
      return { action: 'learning', reason: 'learning_mode', channel };
    }

    if (channel.mode === 'mention_based' && event.type !== 'app_mention') {
      return { action: 'ignore', reason: 'mention_required', channel };
    }

    return { action: 'acp_prompt', reason: channel.mode, channel };
  }

  async spawnLearningInvestigation(event: SlackEvent): Promise<LearningCommandResult> {
    const logsDir = join(homedir(), '.kiro', 'logs');
    await mkdir(logsDir, { recursive: true });

    const safeThreadTs = event.threadTs.replace(/[^0-9.]/g, '_');
    const logPath = join(logsDir, `senior-agent-${event.channelId}-${safeThreadTs}.md`);
    const prompt = JSON.stringify(`[Slack][${event.channelId}][${event.threadTs}] ${event.messageText}`);
    const command = `kiro-cli chat --no-interactive --agent senior-agent ${prompt} > ${JSON.stringify(logPath)} 2>&1`;

    const child = spawn('sh', ['-lc', command], {
      detached: true,
      stdio: 'ignore',
    });

    child.unref();

    return { command, logPath };
  }
}
