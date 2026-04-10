# Interfaces and APIs

## Internal Interfaces

### SessionStore
```typescript
interface SessionStore {
  get(sessionKey: string): Promise<SessionState | null>;
  getByAcpSessionId(acpSessionId: string): Promise<SessionState | null>;
  put(state: SessionState): Promise<void>;
  touch(sessionKey: string, updates: Partial<SessionState>): Promise<SessionState | null>;
}
```
Abstraction over session persistence. Two implementations: `DynamoDbSessionStore` and `InMemorySessionStore`.

### AcpTransport (internal to process-manager.ts)
```typescript
interface AcpTransport {
  initialize(): Promise<void>;
  createSession(agent?: AgentName): Promise<string>;
  loadSession(sessionId: string): Promise<string>;
  switchAgent(sessionId: string, agent: AgentName): Promise<void>;
  prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<void>;
  getSessionModel(sessionId: string): string | undefined;
  getModeModel(modeId: string): string | undefined;
  onEvent(listener: (event: AcpEvent) => void): void;
  close(): void;
}
```
Abstraction over the ACP child process. `JsonRpcAcpTransport` is the production implementation. Tests use `FakeTransport`.

### SlackClientLike
```typescript
interface SlackClientLike {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<{ ts?: string }>;
  };
}
```
Minimal Slack Web API surface used by `SlackStreamController`. Enables testing without the full Slack SDK.

## ACP JSON-RPC Protocol

The app communicates with `kiro-cli acp` over stdio using JSON-RPC 2.0.

### Requests (app → ACP)

| Method | Purpose | Key Params |
|--------|---------|-----------|
| `initialize` | Handshake | `protocolVersion`, `clientCapabilities`, `clientInfo` |
| `session/new` | Create session | `cwd`, `mcpServers` |
| `session/load` | Restore session | `sessionId`, `cwd`, `mcpServers` |
| `session/prompt` | Send user message | `sessionId`, `prompt` |
| `session/set_mode` | Switch agent | `sessionId`, `modeId` |
| `_kiro.dev/commands/execute` | Fallback agent switch | `sessionId`, `command` |

### Notifications (ACP → app)

| Method | Purpose |
|--------|---------|
| `session/update` | Streaming chunks (`agent_message_chunk`, `tool_call`, etc.) |
| `session/request_permission` | Tool permission request (auto-approved) |

### Event Types Emitted Internally

```typescript
interface AcpEvent {
  sessionId: string;
  type: 'started' | 'delta' | 'final' | 'error';
  text?: string;
  error?: string;
  preserveBuffer?: boolean;
}
```

## Slack Bot Commands

| Command | Aliases | Routing Action |
|---------|---------|---------------|
| `@bot escalate` | `@bot /escalate`, `@bot /architect` | `escalate` |
| `@bot de-escalate` | `@bot /de-escalate`, `@bot /senior` | `de_escalate` |
| `@bot status` | `@bot /status` | `status` |
| Any other mention | — | `acp_prompt` |

## Channel Modes

| Mode | Behavior |
|------|----------|
| `learning` | Fire-and-forget `kiro-cli chat` spawn, no ACP session |
| `auto_investigation` | All messages routed to ACP |
| `mention_based` | Only `app_mention` events routed to ACP |

## Response Modes

| Mode | Behavior |
|------|----------|
| `thread_reply` | Reply in the same Slack thread |
| `publish_channel` | Send to a dedicated publish channel via `publishChannelId` |
