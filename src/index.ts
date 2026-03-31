import { config } from 'dotenv';
config(); // loads .env if it exists, no-op otherwise

import { loadAppConfig } from './config/app-config';
import { setLogLevel, parseLogLevel, createLogger } from './logging/logger';

const appConfig = loadAppConfig();
setLogLevel(parseLogLevel(appConfig.logLevel));

const log = createLogger('main');

import { startSlackApp } from './slack-bot/app';

startSlackApp()
  .then(() => {
    log.info('ChatOps AI Agent Slack bot is running');
  })
  .catch((error) => {
    log.error('Failed to start ChatOps AI Agent Slack bot', error);
    process.exitCode = 1;
  });
