import { App } from '@slack/bolt';
import { resolve } from 'node:path';
import { ConfigurationManager } from '../config/manager';
import { CloudWatchLogger } from '../logging/cloudwatch';
import { toSlackEvent, handleSlackEvent } from './events';
import { RoutingLayer } from './routing';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function createSlackApp() {
  const configPath = resolve(process.env.CHANNEL_CONFIG_PATH ?? 'src/config/channels.json');
  const configManager = new ConfigurationManager({ channelsPath: configPath });
  const loadedConfig = await configManager.load();
  const logger = new CloudWatchLogger(process.env.CLOUDWATCH_LOG_GROUP, process.env.CLOUDWATCH_LOG_STREAM);
  const routing = new RoutingLayer(loadedConfig);

  configManager.watch((nextConfig) => routing.updateConfig(nextConfig));

  const app = new App({
    token: requiredEnv('SLACK_BOT_TOKEN'),
    appToken: requiredEnv('SLACK_APP_TOKEN'),
    signingSecret: requiredEnv('SLACK_SIGNING_SECRET'),
    socketMode: true,
  });

  app.event('app_mention', async ({ event }) => {
    const slackEvent = toSlackEvent(event as any, 'app_mention', Number(process.env.MAX_MESSAGE_LENGTH ?? 10000));
    await handleSlackEvent(slackEvent, routing, logger);
  });

  app.event('message', async ({ event }) => {
    if ('subtype' in event && event.subtype) {
      return;
    }

    if (!('user' in event) || !('text' in event) || !('channel' in event) || !('ts' in event)) {
      return;
    }

    const slackEvent = toSlackEvent(event as any, 'message', Number(process.env.MAX_MESSAGE_LENGTH ?? 10000));
    await handleSlackEvent(slackEvent, routing, logger);
  });

  app.error(async (error) => {
    await logger.logError('Bolt app error', error as Error, { component: 'slack-app' });
  });

  return { app, configManager, logger, routing };
}

export async function startSlackApp(port = Number(process.env.PORT ?? 3000)) {
  const { app } = await createSlackApp();
  await app.start(port);
  return app;
}
