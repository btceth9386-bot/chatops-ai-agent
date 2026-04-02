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

  app.command('/usage', async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: [
        '*ChatOps AI Agent — Usage Guide*',
        '',
        '*Commands (mention-based, use in any thread):*',
        '• `@bot <question>` — Ask the AI agent anything; response streams back in the same thread',
        '• `@bot status` or `@bot /status` — Show current agent, model, and session ID for this thread',
        '• `@bot escalate` or `@bot /escalate` or `@bot /architect` — Switch to Architect agent (better for system design)',
        '• `@bot de-escalate` or `@bot /de-escalate` or `@bot /senior` — Switch back to Senior Engineer agent',
        '',
        '*Session model:*',
        '• Each Slack thread has its own independent session context',
        '• The bot remembers the full conversation history within a thread',
        '• Sessions persist across bot restarts (stored in DynamoDB)',
        '• Starting a new thread starts a fresh session',
        '',
        '*Agents:*',
        '• `senior` (default) — Senior Engineer, strong coding and debugging skills',
        '• `architect` — Solutions Architect, better for system design and architecture decisions',
      ].join('\n'),
    });
  });

  app.event('app_mention', async ({ event }) => {
    const slackEvent = toSlackEvent(event as any, 'app_mention', appConfig.maxMessageLength);

    const decision = routing.decide(slackEvent);
    if (decision.action === 'status') {
      const threadTs = slackEvent.threadTs;
      const sessionKey = `THREAD#${slackEvent.channelId}:${threadTs}`;
      const state = await sessionStore.get(sessionKey);
      const agent = state?.activeAgent ?? 'senior-agent';
      const mode = agent === 'architect-agent' ? 'architect' : 'senior';
      const model = state?.acpSessionId
        ? (acpManager.getSessionModel(state.acpSessionId) ?? acpManager.getModeModel(mode) ?? 'unknown')
        : 'no session';
      const sessionId = state?.acpSessionId ? `${state.acpSessionId.slice(0, 8)}…` : 'none';
      await app.client.chat.postMessage({
        channel: slackEvent.channelId,
        thread_ts: threadTs,
        text: `📊 *Session Status*\n• Agent: \`${mode}\`\n• Model: \`${model}\`\n• Session: \`${sessionId}\``,
      });
      log.debug('status reply sent');
      return;
    }

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
