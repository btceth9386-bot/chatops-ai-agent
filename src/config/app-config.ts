import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactionsConfig } from '../types';

export interface AppConfig {
  port: number;
  maxMessageLength: number;
  logLevel: string;
  channelConfigPath: string;
  cloudwatch: {
    logGroup: string;
    logStream: string;
  };
  aws: {
    region: string;
    dynamoTableName: string;
  };
  acpCommand: string;
  acpDefaultAgent: string;
  reactions: ReactionsConfig;
}

const DEFAULT_PATH = resolve(__dirname, '..', '..', '..', 'src', 'config', 'app.json');

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadAppConfig(path = DEFAULT_PATH): AppConfig {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));

  return {
    port: Number(process.env.PORT ?? raw.port ?? 3000),
    maxMessageLength: Number(process.env.MAX_MESSAGE_LENGTH ?? raw.maxMessageLength ?? 10000),
    logLevel: process.env.LOG_LEVEL ?? raw.logLevel ?? 'info',
    channelConfigPath: process.env.CHANNEL_CONFIG_PATH ?? raw.channelConfigPath ?? 'src/config/channels.json',
    cloudwatch: {
      logGroup: process.env.CLOUDWATCH_LOG_GROUP ?? raw.cloudwatch?.logGroup ?? '/chatops-ai-agent/app',
      logStream: process.env.CLOUDWATCH_LOG_STREAM ?? raw.cloudwatch?.logStream ?? 'slack-bot',
    },
    aws: {
      region: process.env.AWS_REGION ?? raw.aws?.region ?? 'us-east-1',
      dynamoTableName: process.env.DYNAMODB_TABLE_NAME ?? raw.aws?.dynamoTableName ?? 'slack-kiro-sessions',
    },
    acpCommand: process.env.ACP_COMMAND ?? raw.acpCommand ?? 'kiro-cli acp',
    acpDefaultAgent: process.env.ACP_DEFAULT_AGENT ?? raw.acpDefaultAgent ?? '',
    reactions: {
      enabled: envFlag('REACTIONS_ENABLED', raw.reactions?.enabled ?? true),
      removeAfterReply: envFlag('REACTIONS_REMOVE_AFTER_REPLY', raw.reactions?.removeAfterReply ?? true),
      emojis: {
        queued: process.env.REACTIONS_EMOJI_QUEUED ?? raw.reactions?.emojis?.queued ?? 'eyes',
        thinking: process.env.REACTIONS_EMOJI_THINKING ?? raw.reactions?.emojis?.thinking ?? 'brain',
        tool: process.env.REACTIONS_EMOJI_TOOL ?? raw.reactions?.emojis?.tool ?? 'wrench',
        coding: process.env.REACTIONS_EMOJI_CODING ?? raw.reactions?.emojis?.coding ?? 'technologist',
        web: process.env.REACTIONS_EMOJI_WEB ?? raw.reactions?.emojis?.web ?? 'globe_with_meridians',
        done: process.env.REACTIONS_EMOJI_DONE ?? raw.reactions?.emojis?.done ?? 'white_check_mark',
        error: process.env.REACTIONS_EMOJI_ERROR ?? raw.reactions?.emojis?.error ?? 'x',
        stallSoft: process.env.REACTIONS_EMOJI_STALL_SOFT ?? raw.reactions?.emojis?.stallSoft ?? 'hourglass_flowing_sand',
        stallHard: process.env.REACTIONS_EMOJI_STALL_HARD ?? raw.reactions?.emojis?.stallHard ?? 'turtle',
      },
      timing: {
        debounceMs: Number(process.env.REACTIONS_TIMING_DEBOUNCE_MS ?? raw.reactions?.timing?.debounceMs ?? 700),
        stallSoftMs: Number(process.env.REACTIONS_TIMING_STALL_SOFT_MS ?? raw.reactions?.timing?.stallSoftMs ?? 10000),
        stallHardMs: Number(process.env.REACTIONS_TIMING_STALL_HARD_MS ?? raw.reactions?.timing?.stallHardMs ?? 30000),
        doneHoldMs: Number(process.env.REACTIONS_TIMING_DONE_HOLD_MS ?? raw.reactions?.timing?.doneHoldMs ?? 1500),
        errorHoldMs: Number(process.env.REACTIONS_TIMING_ERROR_HOLD_MS ?? raw.reactions?.timing?.errorHoldMs ?? 2500),
      },
    },
  };
}
