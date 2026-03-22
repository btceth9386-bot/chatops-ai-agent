import { startSlackApp } from './slack-bot/app';

startSlackApp()
  .then(() => {
    console.log('⚡️ ChatOps AI Agent Slack bot is running');
  })
  .catch((error) => {
    console.error('Failed to start ChatOps AI Agent Slack bot', error);
    process.exitCode = 1;
  });
