# ChatOps AI Agent

Phase 1 foundation for a Slack + ACP based ChatOps bot.

## What is implemented now

- Slack Bolt app bootstrap (`src/slack-bot/app.ts`)
- Channel config loading + validation + hot reload
- Input sanitization
- CloudWatch logging wrapper
- Routing layer for `learning`, `auto_investigation`, and `mention_based`
- Learning mode fire-and-forget `kiro-cli chat` spawn
- ACP process manager with persistent session IDs per Slack thread
- Session store / recovery with DynamoDB when `DYNAMODB_TABLE_NAME` is set, plus in-memory fallback for local/dev
- Per-session FIFO queueing with inflight lock semantics
- Slack placeholder + streaming update controller
- End-to-end handling for normal ACP prompts and `escalate` / `architect` requests in the same session
- Unit tests for routing, formatting, session runtime, and session store
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
  - ACP command
  - optional DynamoDB session table name

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

## ACP runtime contract

By default the app starts one long-lived `kiro-cli acp` child process for the lifetime of the Node process. You can override the command with `ACP_COMMAND`.

The app now treats `kiro-cli acp` as a JSON-RPC ACP server over stdio:

- one `initialize` handshake per process
- one `session/new` call per Slack thread the first time that thread is routed into ACP
- repeated `session/prompt` calls against that ACP session for later messages in the same thread
- `session/update` notifications are translated into Slack streaming deltas/finals as best-effort

### Requests sent by this app

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "chatops-ai-agent", "version": "0.1.0" } } }
```

```json
{ "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { "cwd": "/path/to/repo", "agentName": "senior-agent" } }
```

```json
{ "jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": { "sessionId": "acp-session-id", "prompt": "Please investigate the spike" } }
```

### Notifications/results consumed by this app

The adapter currently understands:

- `session/update` notifications carrying chunk-style updates such as `agent_message_chunk`
- `session/prompt` responses containing final content
- stderr / JSON-RPC errors as Slack-visible failures

## Local run

```bash
cp .env.example .env
# fill in real values
npm install
npm run build
npm run restart:clean
```

`npm run restart:clean` is the preferred local/dev entrypoint. It:

- stops old `node dist/src/index.js` processes
- stops old `kiro-cli acp` / `kiro-cli-chat acp` processes
- refuses to start if cleanup did not actually succeed
- loads `.env` automatically when present
- starts exactly one fresh bot instance

If you prefer, you can still export variables from your shell and run `npm start` directly, but for repeated local debugging the clean restart script is safer.

## Channel config examples

`thread_reply` means reply inside the same Slack thread.

`publish_channel` means send the final summary to a dedicated channel, using `publishChannelId`.

## Remaining gaps after this PR

This is now a minimal viable Phase 1 implementation, but a few production-hardening gaps still remain:

- The ACP adapter is now aligned to the observed `initialize` / `session/new` / `session/prompt` JSON-RPC surface, but the exact full `session/update` notification schema is still inferred from binary strings and live error probes rather than an official protocol doc
- Permission/auth flows from the real ACP session (for example request-permission notifications or profile/auth bootstrap failures) are not yet turned into interactive Slack affordances
- DynamoDB persistence currently stores the recoverable session mapping and Slack placeholder state, but not the in-memory queued backlog across process restarts
- `publish_channel` currently streams into the publish target thread/message directly; if product wants a final summarized post plus source-thread backlink formatting, that should be added as a follow-up
- No rate-limit/backoff layer yet for Slack message updates
