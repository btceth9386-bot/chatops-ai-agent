# ChatOps AI Agent

Phase 1 foundation for a Slack + ACP based ChatOps bot.

## What is implemented now

- Slack Bolt app bootstrap (`src/slack-bot/app.ts`)
- Channel config loading + validation + hot reload
- Input sanitization
- CloudWatch logging wrapper
- Routing layer for `learning`, `auto_investigation`, and `mention_based`
- Learning mode fire-and-forget `kiro-cli chat` spawn
- Slack response formatter helpers
- Node entrypoint (`src/index.ts`)

## Configuration strategy

Use both:

- `src/config/channels.json` for non-secret operational config
  - channel IDs
  - routing mode
  - response mode
  - publish target channel ID
- environment variables for secrets and environment-specific runtime values
  - Slack tokens
  - signing secret
  - CloudWatch log group/stream
  - deployment-specific paths

This split keeps channel policy reviewable in git while keeping secrets out of the repo.

## Slack app setup

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. App name: `ChatOps AI Agent`
4. Pick your workspace
5. Under **Socket Mode**, enable Socket Mode and create an app-level token with scope `connections:write`
6. Under **Basic Information**, copy the **Signing Secret**
7. Under **OAuth & Permissions**, add bot scopes:
   - `app_mentions:read`
   - `channels:history`
   - `channels:read`
   - `chat:write`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `mpim:history`
   - `mpim:read`
8. Install the app to the workspace
9. Copy the Bot User OAuth Token (`xoxb-...`)
10. Put values into your shell environment or `.env`
11. Invite the bot into the target channels
12. Replace example channel IDs in `src/config/channels.json`

## Local run

```bash
cp .env.example .env
# fill in real values
npm install
npm run build
set -a; source .env; set +a
npm start
```

If you prefer, you can export the variables from your shell instead of using `.env`.

## Channel config examples

`thread_reply` means reply inside the same Slack thread.

`publish_channel` means send the final summary to a dedicated channel, using `publishChannelId`.

## Current gap to full Phase 1

This branch now covers the Slack-facing foundation, but the following items are still not implemented:

- persistent `kiro-cli acp` process management
- ACP session mapping / recovery via DynamoDB
- FIFO queueing and inflight locks
- streaming placeholder updates to Slack
- final end-to-end ACP prompt → streamed response flow
- architect escalation inside the same ACP session

That means the bot can now be configured and started, but Phase 1 is not yet complete until ACP runtime integration is added.
