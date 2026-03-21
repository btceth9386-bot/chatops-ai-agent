import { readFile } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelConfig } from '../types';

export interface BotConfigFiles {
  channelsPath: string;
  mcpServicesPath: string;
}

export interface LoadedConfig {
  channelAllowlist: ChannelConfig[];
  mcpServices: Record<string, unknown>;
}

export class ConfigurationManager {
  private lastValidConfig: LoadedConfig | null = null;
  private watching = false;

  constructor(private readonly files: BotConfigFiles) {}

  async load(): Promise<LoadedConfig> {
    const channelsPath = resolve(this.files.channelsPath);
    const mcpServicesPath = resolve(this.files.mcpServicesPath);

    const [channelsRaw, mcpRaw] = await Promise.all([
      readFile(channelsPath, 'utf-8'),
      readFile(mcpServicesPath, 'utf-8'),
    ]);

    const parsed = {
      channelAllowlist: JSON.parse(channelsRaw) as ChannelConfig[],
      mcpServices: JSON.parse(mcpRaw) as Record<string, unknown>,
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

    if (!config.mcpServices || typeof config.mcpServices !== 'object') {
      throw new Error('mcpServices must be an object');
    }
  }

  watch(onReload?: (config: LoadedConfig) => void): void {
    if (this.watching) return;
    this.watching = true;

    const watchTargets = [this.files.channelsPath, this.files.mcpServicesPath].map((p) => resolve(p));

    for (const target of watchTargets) {
      if (!existsSync(target)) continue;
      watch(target, async () => {
        try {
          const newConfig = await this.load();
          onReload?.(newConfig);
        } catch (error) {
          console.error('[ConfigurationManager] invalid config change, keeping last valid config', error);
        }
      });
    }
  }

  getLastValidConfig(): LoadedConfig | null {
    return this.lastValidConfig;
  }
}
