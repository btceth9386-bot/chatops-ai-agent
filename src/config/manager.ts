import { readFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelConfig } from '../types';

export interface BotConfigFiles {
  channelsPath: string;
}

export interface LoadedConfig {
  channelAllowlist: ChannelConfig[];
}

export class ConfigurationManager {
  private lastValidConfig: LoadedConfig | null = null;
  private watching = false;

  constructor(private readonly files: BotConfigFiles) {}

  async load(): Promise<LoadedConfig> {
    const channelsPath = resolve(this.files.channelsPath);
    const channelsRaw = await readFile(channelsPath, 'utf-8');

    const parsed = {
      channelAllowlist: JSON.parse(channelsRaw) as ChannelConfig[],
    };

    this.validate(parsed);
    this.lastValidConfig = parsed;
    return parsed;
  }

  validate(config: LoadedConfig): void {
    if (!Array.isArray(config.channelAllowlist)) {
      throw new Error('channelAllowlist must be an array');
    }

    for (const channel of config.channelAllowlist) {
      if (!channel.channelId || typeof channel.channelId !== 'string') {
        throw new Error('channel.channelId is required');
      }
      if (!['learning', 'auto_investigation', 'mention_based'].includes(channel.mode)) {
        throw new Error(`invalid channel mode for ${channel.channelId}`);
      }
      if (channel.responseMode && !['thread_reply', 'publish_channel'].includes(channel.responseMode)) {
        throw new Error(`invalid response mode for ${channel.channelId}`);
      }
    }
  }

  watch(onReload?: (config: LoadedConfig) => void): void {
    if (this.watching) return;
    this.watching = true;

    const target = resolve(this.files.channelsPath);
    if (!existsSync(target)) return;

    watch(target, async () => {
      try {
        const newConfig = await this.load();
        onReload?.(newConfig);
      } catch (error) {
        console.error('[ConfigurationManager] invalid config change, keeping last valid config', error);
      }
    });
  }

  getLastValidConfig(): LoadedConfig | null {
    return this.lastValidConfig;
  }
}
