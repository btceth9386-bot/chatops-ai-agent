import { App } from '@slack/bolt';
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function asciiTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (cells: string[]) => '|' + cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|') + '|';
  return [sep, fmt(headers), sep, ...rows.map(fmt), sep].join('\n');
}

function loadSkills(): Array<{ name: string; description: string }> {
  const dir = join(homedir(), '.kiro', 'skills');
  try {
    return readdirSync(dir)
      .map((name) => {
        try {
          const content = readFileSync(join(dir, name, 'SKILL.md'), 'utf-8');
          const m = content.match(/^description:\s*(.+)$/m);
          return { name, description: m ? m[1].trim().slice(0, 80) : '—' };
        } catch {
          return null;
        }
      })
      .filter((s): s is { name: string; description: string } => s !== null);
  } catch {
    return [];
  }
}

function loadMcpServers(): Array<{ name: string; command: string }> {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.kiro', 'settings', 'mcp.json'), 'utf-8'));
    return Object.entries(raw?.mcpServers ?? {}).map(([name, cfg]) => ({
      name,
      command: (cfg as Record<string, unknown>)?.command as string ?? '—',
    }));
  } catch {
    return [];
  }
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
  const runtime = new SlackSessionRuntime(acpManager, sessionStore, streamController, logger, app.client as any, appConfig.reactions);

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

  app.command('/skills', async ({ ack, respond }) => {
    await ack();
    const skills = loadSkills();
    const text = skills.length === 0
      ? 'No skills found in `~/.kiro/skills/`'
      : '```\n' + asciiTable(['Skill', 'Description'], skills.map((s) => [s.name, s.description])) + '\n```';
    await respond({ response_type: 'ephemeral', text });
  });

  app.command('/mcp', async ({ ack, respond }) => {
    await ack();
    const servers = loadMcpServers();
    const text = servers.length === 0
      ? 'No MCP servers configured in `~/.kiro/settings/mcp.json`'
      : '```\n' + asciiTable(['Server', 'Command'], servers.map((s) => [s.name, s.command])) + '\n```';
    await respond({ response_type: 'ephemeral', text });
  });

  app.command('/usage', async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: 'ephemeral',
      text: [
        '*ChatOps AI Agent — Usage Guide*',
        '',
        '*Mention-based commands (use inside a Slack thread):*',
        '• `@bot <question>` — Ask the AI agent anything; response streams back in the same thread',
        '• `@bot status` or `@bot /status` — Show current agent, model, and session ID for this thread',
        '• `@bot escalate` or `@bot /escalate` or `@bot /architect` — Switch to Architect agent (better for system design)',
        '• `@bot de-escalate` or `@bot /de-escalate` or `@bot /senior` — Switch back to Senior Engineer agent',
        '',
        '*Slash commands (available anywhere):*',
        '• `/usage` — Show this usage guide',
        '• `/skills` — List loaded custom skills from `~/.kiro/skills/`',
        '• `/mcp` — List configured MCP servers from `~/.kiro/settings/mcp.json`',
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
