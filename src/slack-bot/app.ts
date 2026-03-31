import { App } from '@slack/bolt';
import { resolve } from 'node:path';
import { loadAppConfig } from '../config/app-config';
import { ConfigurationManager } from '../config/manager';
import { CloudWatchLogger } from '../logging/cloudwatch';
import { createLogger } from '../logging/logger';
import { toSlackEvent, handleSlackEvent } from './events';
import { RoutingLayer } from './routing';
import { createSessionStore } from '../sessions/store';
import { AcpProcessManager } from '../acp/process-manager';
import { SlackStreamController } from './stream-controller';
import { SlackSessionRuntime } from './session-runtime';

const log = createLogger('app');

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function createSlackApp() {
  const appConfig = loadAppConfig();
  const configPath = resolve(appConfig.channelConfigPath);
  const configManager = new ConfigurationManager({ channelsPath: configPath });
  const loadedConfig = await configManager.load();
  const logger = new CloudWatchLogger(appConfig.cloudwatch.logGroup, appConfig.cloudwatch.logStream);
  const routing = new RoutingLayer(loadedConfig);

  configManager.watch((nextConfig) => routing.updateConfig(nextConfig));

  const app = new App({
    token: requiredEnv('SLACK_BOT_TOKEN'),
    appToken: requiredEnv('SLACK_APP_TOKEN'),
    signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),
    socketMode: true,
  });

  const sessionStore = createSessionStore({
    tableName: appConfig.aws.dynamoTableName,
  });
  const acpCommand = appConfig.acpDefaultAgent
    ? `${appConfig.acpCommand} --agent ${appConfig.acpDefaultAgent}`
    : appConfig.acpCommand;
  const acpManager = new AcpProcessManager({ command: acpCommand });
  const streamController = new SlackStreamController(app.client as any);
  const runtime = new SlackSessionRuntime(acpManager, sessionStore, streamController, logger);

  let cleanedUp = false;
  const cleanup = (reason: string) => {
    log.info('cleanup invoked', { reason, cleanedUp });
    if (cleanedUp) return;
    cleanedUp = true;
    acpManager.close();
  };

  process.on('beforeExit', (code) => {
    log.debug('process beforeExit', { code });
  });

  process.on('uncaughtException', (error) => {
    log.error('uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });

  process.once('SIGINT', () => cleanup('SIGINT'));
  process.once('SIGTERM', () => cleanup('SIGTERM'));
  process.once('exit', (code) => cleanup(`exit:${code}`));

  app.event('app_mention', async ({ event }) => {
    log.info('app_mention received', { user: (event as any).user, channel: (event as any).channel, ts: (event as any).ts, thread_ts: (event as any).thread_ts });
    const slackEvent = toSlackEvent(event as any, 'app_mention', appConfig.maxMessageLength);
    await handleSlackEvent(slackEvent, routing, logger, runtime);
    log.debug('app_mention handled');
  });

  app.event('message', async ({ event }) => {
    if ('subtype' in event && event.subtype) {
      return;
    }

    if (!('user' in event) || !('text' in event) || !('channel' in event) || !('ts' in event)) {
      return;
    }

    const slackEvent = toSlackEvent(event as any, 'message', appConfig.maxMessageLength);
    await handleSlackEvent(slackEvent, routing, logger, runtime);
  });

  app.error(async (error) => {
    log.error('Bolt global error', error);
    await logger.logError('Bolt app error', error as Error, { component: 'slack-app' });
  });

  return { app, configManager, logger, routing, runtime, sessionStore, acpManager };
}

export async function startSlackApp(port?: number) {
  const appConfig = loadAppConfig();
  const { app } = await createSlackApp();
  await app.start(port ?? appConfig.port);
  return app;
}
