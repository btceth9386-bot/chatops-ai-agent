import { readFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelConfig } from '../types';
import { createLogger } from '../logging/logger';

const log = createLogger('config');

export interface BotConfigFiles {
  channelsPath: string;
}

export interface LoadedConfig {
  channelAllowlist: ChannelConfig[];
}

const VALID_CHANNEL_MODES = new Set(['learning', 'auto_investigation', 'mention_based']);
const VALID_RESPONSE_MODES = new Set(['thread_reply', 'publish_channel']);

export class ConfigurationManager {
  private lastValidConfig: LoadedConfig | null = null;
  private watching = false;

  constructor(private readonly files: BotConfigFiles) {}

  async load(): Promise<LoadedConfig> {
    const channelsPath = resolve(this.files.channelsPath);
    const channelsRaw = await readFile(channelsPath, 'utf-8');
    const parsedChannels = JSON.parse(channelsRaw) as unknown;

    const normalized = Array.isArray(parsedChannels)
      ? { channelAllowlist: parsedChannels as ChannelConfig[] }
      : ({ channelAllowlist: (parsedChannels as { channels?: ChannelConfig[] }).channels ?? [] } as LoadedConfig);

    this.validate(normalized);
    this.lastValidConfig = normalized;
    return normalized;
  }

  validate(config: LoadedConfig): void {
    if (!Array.isArray(config.channelAllowlist)) {
      throw new Error('channelAllowlist must be an array');
    }

    for (const channel of config.channelAllowlist) {
      if (!channel.channelId || typeof channel.channelId !== 'string') {
        throw new Error('channel.channelId is required');
      }

      if (!VALID_CHANNEL_MODES.has(channel.mode)) {
        throw new Error(`invalid channel mode for ${channel.channelId}`);
      }

      if (!VALID_RESPONSE_MODES.has(channel.responseMode)) {
        throw new Error(`invalid response mode for ${channel.channelId}`);
      }

      if (channel.responseMode === 'publish_channel' && !channel.publishChannelId) {
        throw new Error(`publishChannelId is required when responseMode=publish_channel for ${channel.channelId}`);
      }
    }
  }

  watch(onReload?: (config: LoadedConfig) => void): void {
    if (this.watching) return;

    const target = resolve(this.files.channelsPath);
    if (!existsSync(target)) return;

    this.watching = true;

    watch(target, async () => {
      try {
        const nextConfig = await this.load();
        onReload?.(nextConfig);
      } catch (error) {
        console.error('[ConfigurationManager] invalid config change, keeping last valid config', error);
      }
    });
  }

  getLastValidConfig(): LoadedConfig | null {
    return this.lastValidConfig;
  }
}
