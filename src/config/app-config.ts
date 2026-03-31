import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
}

const DEFAULT_PATH = resolve(__dirname, '..', '..', '..', 'src', 'config', 'app.json');

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
  };
}
