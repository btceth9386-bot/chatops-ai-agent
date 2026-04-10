# Components

## Core Components

### SlackSessionRuntime (`src/slack-bot/session-runtime.ts`)
Central orchestrator. Owns the per-thread FIFO queue, inflight lock, and ACP session lifecycle. Receives routed Slack events via `enqueue()`, dispatches them to ACP via `processNext()`, and handles ACP responses via `handleAcpEvent()`. Coordinates between `AcpProcessManager`, `SessionStore`, and `SlackStreamController`.

Key responsibilities:
- Maps Slack threads to ACP sessions
- Serializes requests per thread (FIFO + inflight lock)
- Handles escalation/de-escalation agent switches
- Recovers stale inflight state on session mismatch
- Prepends session notices (e.g., fallback-from-load warnings)

### AcpProcessManager (`src/acp/process-manager.ts`)
Manages the `kiro-cli acp` child process and the JSON-RPC protocol. Contains two classes:

- **JsonRpcAcpTransport** — Spawns the child process, handles stdin/stdout JSON-RPC framing, manages pending request/response correlation, parses `session/update` notifications, auto-approves `session/request_permission`, and emits typed `AcpEvent`s.
- **AcpProcessManager** — Higher-level wrapper that tracks session-key-to-session-ID mappings, deduplicates concurrent `ensureSession` calls, handles `session/load` with timeout + fallback to `session/new`, and provides transport recycling on failure.

### SlackStreamController (`src/slack-bot/stream-controller.ts`)
Manages Slack message lifecycle for streaming responses:
- Posts placeholder messages ("Working on it…")
- Throttles delta updates (900ms) to avoid Slack rate limits
- Splits final messages that exceed Slack's byte limit
- Queues updates per message to prevent out-of-order edits
- Truncates streaming text to stay within Slack's 3900-byte limit

### RoutingLayer (`src/slack-bot/routing.ts`)
Decides how to handle each Slack event based on channel configuration:
- `learning` → fire-and-forget `kiro-cli chat` spawn
- `acp_prompt` → enqueue to session runtime
- `escalate` / `de_escalate` → agent switch via session runtime
- `status` → show current agent/model/session info
- `ignore` → channel not allowed or mention required

### ConfigurationManager (`src/config/manager.ts`)
Loads and validates `channels.json`. Watches the file for changes and hot-reloads on modification. Keeps the last valid config as fallback if a reload produces invalid JSON.

## Supporting Components

### SessionStore (`src/sessions/store.ts`)
Interface with two implementations:
- **DynamoDbSessionStore** — Production store using DynamoDB. PK is `THREAD#{channelId}:{threadTs}`. GSI on `acpSessionId` for reverse lookups. TTL-based expiry (90 days).
- **InMemorySessionStore** — Dev/test fallback using a `Map`.

Factory function `createSessionStore()` picks the implementation based on whether `tableName` is configured.

### CloudWatchLogger (`src/logging/cloudwatch.ts`)
Writes structured log entries to CloudWatch Logs. Auto-creates log streams. Provides `logInfo`, `logWarn`, `logError` methods with component/context metadata.

### Console Logger (`src/logging/logger.ts`)
Lightweight tagged logger with configurable log levels (DEBUG/INFO/WARN/ERROR). Used throughout the codebase via `createLogger(tag)`.

### Event Handler (`src/slack-bot/events.ts`)
Converts raw Slack Bolt events into typed `SlackEvent` objects (via `toSlackEvent`), then dispatches through the routing layer (via `handleSlackEvent`).

### Input Sanitizer (`src/slack-bot/sanitizer.ts`)
Strips control characters and truncates messages exceeding `maxMessageLength` (default 10,000 chars).

### Response Formatter (`src/slack-bot/response-formatter.ts`)
Formats `SafeSummary` objects for Slack display. Splits long messages at paragraph/line/word boundaries to respect Slack's byte limits.

### App Bootstrap (`src/slack-bot/app.ts`)
Initializes Slack Bolt, loads MCP server configs and skills, creates all runtime components, registers event listeners, and starts the app in Socket Mode.
