# Design Document: ChatOps AI Agent (v2 — ACP + Slack Integration)

## Overview

The ChatOps AI Agent is an internal AI-powered DevOps/SRE assistant that integrates with Slack to provide intelligent incident triage, investigation, and resolution guidance. The v2 architecture replaces the per-request `kiro-cli chat` spawn model with a persistent `kiro-cli acp` process using the Agent Client Protocol (ACP) for session management, streaming responses, and agent switching.

The system follows a layered architecture where a Slack Bot (Node.js + Bolt SDK) acts as the secure entry point and routing layer, a single long-lived ACP process serves as the AI agent runtime with per-thread session mapping, and MCP servers provide controlled access to internal systems.

The system implements a continuous learning loop: session logs from investigations feed into a Skill Analysis Cronjob that proposes Custom Skill improvements via GitHub PRs, which are human-reviewed before integration. A weekly Benchmark Cronjob tracks skill effectiveness and alerts on regressions.

### Key Design Decisions

1. **Slack Bolt SDK (Node.js + TypeScript)** chosen for the bot layer — mature, well-documented, native Slack event handling, built-in TypeScript type definitions
2. **Single long-lived `kiro-cli acp` process** — The ACP process is initialized once at application startup and reused for all requests. No per-request process spawning is allowed. Each Slack thread maps to one ACP session via `session/new` and is reused via `session/prompt`. **Implementation note:** The ACP process is spawned via `child_process.spawn` and communicated over stdio (JSON-RPC 2.0, line-delimited). The process must be treated as a long-lived stateful runtime.
3. **Two-agent model** (Senior_Agent → Architect_Agent) — Senior_Agent handles all requests by default, Architect_Agent activated only by explicit human escalation within the same ACP session. Agent switching via `session/set_mode` (preferred) or Kiro slash command fallback
4. **Per-session sequential execution with FIFO queue** — each ACP session processes one prompt at a time; concurrent requests to the same session are queued. Multiple sessions may run concurrently (recommended limit: 2-4)
5. **Streaming with rate-limited Slack output** — ACP `AgentMessageChunk` notifications are buffered and flushed to Slack every 2-5 seconds via placeholder message updates, not sent individually
6. **Slack routing modes** — channels are configured as learning (spawn `kiro-cli chat` for silent investigation + session log capture), auto_investigation (automatic ACP session), or mention_based (require @mention for ACP session)
7. **MCP servers as security boundary** — all system access goes through MCP, ensuring redaction and summarization
8. **Cronjob-based skill analysis** — decouples learning from real-time request handling, avoids latency impact
9. **GitHub PRs for skill changes** — leverages existing review workflows, provides audit trail
10. **EC2 for v2** — minimal infrastructure overhead, single-instance deployment
11. **DynamoDB for session persistence** — `slack-kiro-sessions` table stores ACP session mappings for crash recovery. In-memory Map as primary lookup (hot path), DynamoDB only read on cache miss (process restart). On-demand capacity, TTL at 90 days, negligible cost

## Architecture

### System Architecture Diagram

```
┌───────────────────────────────────────────────────────────────┐
│  SLACK WORKSPACE                                              │
│                     ┌──────────────────┐                      │
│                     │ Channel / Thread  │                      │
│                     └────────┬─────────┘                      │
└──────────────────────────────┼────────────────────────────────┘
                               │
                          Events (mentions, threads)
                               │
═══════════════════════════════════════════════════════════════════
  EC2 INSTANCE
═══════════════════════════════════════════════════════════════════
                               │
  SLACK BOT (Node.js + TypeScript + Bolt SDK)
  ────────────────────────────────────────────────────────────────
                               │
  ┌─────────────┐   ┌─────────▼─────────┐   ┌────────────────┐
  │   Event     │──▶│  Routing Layer    │──▶│  ACP Session   │
  │   Handler   │   │  (mode + policy)  │   │  Manager       │
  └─────────────┘   └───────────────────┘   └───────┬────────┘
                                                    │
  ┌─────────────┐   ┌───────────────────┐           │
  │  Slack      │◀──│  Stream           │           │
  │  Stream     │   │  Controller       │           │
  │  Controller │   │  (buffer+flush)   │           │
  └──────┬──────┘   └───────────────────┘           │
         │                                          │
    Update Slack                          session/new | session/prompt
    (every 2-5s)                                    │
         │                                          ▼

  KIRO CLI ACP (single long-lived process)
  ────────────────────────────────────────────────────────────────

            ┌────────────────────────────────────┐
            │      Senior_Agent (default)        │
            │  - Triage & classify incident      │
            │  - Log & metric queries            │
            │  - Generate Safe_Summary           │
            └──────────────────┬─────────────────┘
                               │
              session/set_mode │ (human-triggered)
                               │
                               ▼
                 ┌──────────────────────────┐
                 │    Architect_Agent       │
                 │  - Deep analysis         │
                 │  - Remediation           │
                 │    validation            │
                 └────────────┬─────────────┘
                              │
                         query│
                              │

  MCP SERVERS (security boundary)
  ────────────────────────────────────────────────────────────────
             │                           │
             ▼                           ▼
  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐
  │   Logs_MCP     │  │  Grafana_MCP   │  │    GitHub_MCP      │
  │ - Allowlist    │  │ - Dashboards   │  │ - Workflow allow   │
  │ - Redaction    │  │ - Metrics      │  │ - Poll completion  │
  │ - Summarize    │  │ - Anomalies    │  │ - Timeout: 600s    │
  └───────┬────────┘  └───────┬────────┘  └─────────┬──────────┘
          │                   │                      │

  SCHEDULED JOBS
  ────────────────────────────────────────────────────────────────

  ┌──────────────────────────┐  ┌──────────────────────────────┐
  │  Skill_Analysis_Cronjob  │  │  Benchmark_Cronjob           │
  │  - Every 30 min          │  │  - Weekly                    │
  │  - Scan un-analyzed logs │  │  - Aggregate metrics         │
  │  - Create skill PRs      │  │  - Detect regressions        │
  │  - Mark logs -analyzed   │  │  - Alert on Slack            │
  └────────────┬─────────────┘  └──────────────┬───────────────┘
               │                               │
═══════════════╪═══════════════════════════════╪═══════════════════
               │                               │
               ▼                               ▼

  EXTERNAL SERVICES
  ────────────────────────────────────────────────────────────────

  ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌─────────────┐
  │ Log Systems  │ │ Grafana  │ │ GitHub       │ │ GitHub Repo │
  │              │ │          │ │ Actions      │ │ (Skills     │
  │              │ │          │ │              │ │  & PRs)     │
  └──────────────┘ └──────────┘ └──────────────┘ └─────────────┘


  AWS
  ────────────────────────────────────────────────────────────────
  ┌────────────────────────┐  ┌─────────────────────────────────┐
  │   CloudWatch LogGroup  │  │  DynamoDB: slack-kiro-sessions  │
  │                        │  │  PK: THREAD#{channel}:{thread}  │
  └────────────────────────┘  │  TTL: 90 days                   │
                              └─────────────────────────────────┘
```

### Request Flow

```
  Slack        Slack Bot       ACP Process  Senior_Agent   Architect     MCP Servers    Internal Sys
    |              |              |              |              |              |              |
    |--@bot msg--->|              |              |              |              |              |
    |              |--route------>|              |              |              |              |
    |              |  (mode+policy)              |              |              |              |
    |              |--sanitize--->|              |              |              |              |
    |              |  input       |              |              |              |              |
    |<--ack (<6s)--|              |              |              |              |              |
    |<--placeholder|              |              |              |              |              |
    |   message    |              |              |              |              |              |
    |              |--session/new or session/prompt              |              |              |
    |              |              |--init------->|              |              |              |
    |              |              |              |--triage----->|              |              |
    |              |              |              |  & classify  |              |              |
    |              |              |              |--query------>|              |              |
    |              |              |              |  logs/metrics|              |              |
    |              |              |              |              |--fetch------->|              |
    |              |              |              |              |              |--raw data--->|
    |              |              |              |              |<--summarized--|              |
    |              |              |              |<--redacted---|              |              |
    |              |              |              |              |              |              |
    |              |<--AgentMessageChunk (streaming)            |              |              |
    |<--update msg-|  (buffered, every 2-5s)    |              |              |              |
    |              |<--ToolCallUpdate            |              |              |              |
    |<--status msg-|  (🔍 Checking logs...)     |              |              |              |
    |              |              |              |              |              |              |
    |              |              |              |  [if human triggers escalation]            |
    |              |--session/set_mode---------->|              |              |              |
    |              |              |              |              |--deep query-->|              |
    |              |              |              |              |<--results-----|              |
    |              |              |              |              |              |              |
    |              |<--TurnEnd----|              |              |              |              |
    |<--final msg--|  (Safe_Summary replaces placeholder)      |              |              |
    |  to thread   |              |              |              |              |              |
```


### Skill Learning Loop

```
                                    Skill Learning Loop
                                    ===================

+---------------------------+                +---------------------------+
| ACP modes                 |                | Learning mode             |
| (auto_investigation,      |                | (kiro-cli chat spawn)     |
|  mention_based)           |                |                           |
| Bot assembles session     |                | stdout redirect to file   |
| content on TurnEnd        |                |                           |
+------------+--------------+                +-------------+-------------+
             |                                             |
             +-------------------+-------------------------+
                                 |
                                 v
                    +------------------------+
                    |   ~/.kiro/logs/         |     every 30 min
                    |   (same format)        |-------------------->+-------------------------+
                    +------------------------+                     | Skill_Analysis_Cronjob  |
                             |                                     +------------+------------+
                             |                                                  |
                             |                                       +----------+-----------+
                             |                                       |                      |
                             |                                 semantic match          no match
                             |                                       |                      |
                             |                                       v                      v
                             |                              +----------------+    +------------------+
                             |                              | Update Existing|    | New Skill        |
                             |                              | Skill          |    | Proposal         |
                             |                              +-------+--------+    +--------+---------+
                             |                                      |                      |
                             |                                      +----------+-----------+
                             |                                                 |
                             |                                            gh CLI
                             |                                                 |
                             |                                                 v
                             |                                      +---------------------+
                             |                                      | Skill_Improvement_PR|
                             |                                      +----------+----------+
                             |                                                 |
                             |                                            review
                             |                                                 |
                             |                                                 v
                             |                                      +---------------------+
                             |                                      |   Human Reviewer    |
                             |                                      +----------+----------+
                             |                                                 |
                             |                                         approve & merge
                             |                                                 |
                             |                                                 v
                             |                                      +---------------------+
                             |    extract metrics                   |  Skills Directory   |----> Next Session (Senior_Agent)
                             |                                      +---------------------+
                             v
                    +-------------------+       weekly       +-------------------------+
                    |  Session_Metrics  |------------------->|   Benchmark_Cronjob     |
                    +-------------------+                    +------------+------------+
                                                                         |
                                                                         v
                                                            +-------------------------+
                                                            |   Benchmark Report      |
                                                            +------------+------------+
                                                                         |
                                                                 regression detected?
                                                                         |
                                                                         v
                                                            +-------------------------+
                                                            |     Slack Alert         |
                                                            +-------------------------+
```

## Components and Interfaces

### 1. Slack Bot (Node.js + TypeScript + Bolt SDK)

The Slack Bot is the system's entry point and security boundary facing Slack. It is NOT an AI agent — it handles event ingestion, routing, input sanitization, ACP session management, streaming output aggregation, and response formatting. Built with TypeScript using the `@slack/bolt` package which provides built-in type definitions.

#### Interface

```typescript
// Configuration
interface SlackBotConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  channelAllowlist: ChannelConfig[];   // Channel configs with routing modes
  cloudwatchLogGroup: string;
  dynamoTableName: string;             // Default: "slack-kiro-sessions"
  maxMessageLength: number;            // Default: 10000 characters
  maxActiveSessions: number;           // Default: 4
  configFilePath: string;              // Path to allowlist config
}

// Channel routing configuration
interface ChannelConfig {
  channelId: string;
  mode: 'learning' | 'auto_investigation' | 'mention_based';
  responseMode: 'thread_reply' | 'publish_channel';
  publishChannelId?: string;           // Required when responseMode is 'publish_channel'
}

// Parsed Slack event
interface SlackEvent {
  messageText: string;
  channelId: string;
  threadTs: string;
  userId: string;
  timestamp: string;
}

// Sanitization result
interface SanitizedInput {
  text: string;
  wasTruncated: boolean;
  originalLength: number;
}

// Module exports
interface SlackBotModule {
  sanitizeInput(raw: string): SanitizedInput;
  isChannelAllowed(channelId: string): boolean;
  getChannelConfig(channelId: string): ChannelConfig | null;
  postResponse(channelId: string, threadTs: string, summary: string): Promise<void>;
  loadConfig(path: string): SlackBotConfig;
  reloadConfig(): Promise<void>;
}
```

#### Behavior

- Listens via Bolt SDK `app.event('app_mention')` and `app.event('message')` (for threads)
- Routes events through the Routing Layer based on channel mode configuration
- Learning mode: spawns `kiro-cli chat --no-interactive --agent senior-agent "<prompt>"` with stdout redirected to `~/.kiro/logs/`, fire-and-forget, no ACP session, no Slack response
- Auto-investigation mode: automatically creates/reuses ACP session with Senior_Agent
- Mention-based mode: requires `app_mention` event before creating/reusing ACP session
- Validates channel against allowlist before processing
- Sanitizes input: strips control characters, enforces 10000 char limit
- Delegates to ACP Session Manager for session lifecycle
- Delegates to Slack Stream Controller for streaming output
- Logs all Bolt SDK errors, connection errors, auth failures, and API errors to CloudWatch
- Retries Slack post failures up to 3 times with exponential backoff
- Reloads config file within 60 seconds of changes (file watcher or polling)

### 2. Kiro CLI ACP Runtime

The Kiro CLI runs as a single long-lived `kiro-cli acp` process, initialized once at startup via `child_process.spawn` and communicated over stdio (JSON-RPC 2.0, line-delimited). It manages ACP sessions mapped to Slack threads and hosts the two-agent model with agent switching support. The process must be treated as a long-lived stateful runtime — no per-request spawning is allowed.

#### ACP Process Lifecycle

```
spawn kiro-cli acp
  → initialize
  → session/new (per Slack thread)
  → session/prompt (per request)
  → receive streaming notifications (AgentMessageChunk, ToolCallUpdate)
  → TurnEnd
  → repeat
```

#### Session Identity

```
session_key = channel_id + ":" + root_thread_ts
```

> `team_id` is intentionally omitted for v2 (single-workspace assumption)

#### Agent Model

```typescript
// Agents
type AgentName = 'senior-agent' | 'architect-agent';

// Agent definition
interface AgentConfig {
  name: AgentName;
  role: string;
  tools: string[];                     // MCP tools available
  skills: string[];                    // Custom skill files loaded
}

// Triage result from Senior_Agent
interface TriageResult {
  incidentType: 'alert' | 'investigation' | 'validation' | 'general_query';
  severity: string;
  reasoning: string;
}

// Final output
interface SafeSummary {
  findings: string;
  hypotheses: string[];
  recommendedActions: string[];
  totalLength: number;                 // Must not exceed 2000 chars
}
```

#### Agent Switching

```typescript
// Preferred method
// session/set_mode → architect-agent

// Fallback (experimental)
// _kiro.dev/commands/execute → /agent swap architect-agent
```

Rules:
- Agent switching MUST occur within the same ACP session
- Agent selection is controlled by Slack Bot routing, NOT automatically decided by Kiro
- Escalation MUST be explicitly triggered by human user

### 3. MCP Servers

MCP servers form the data security boundary. They enforce allowlists, redact sensitive data, and return summarized results.

#### Logs_MCP Interface

```typescript
interface LogsQueryRequest {
  service: string;                     // Must be in service allowlist
  timeWindowStart: string;             // ISO 8601
  timeWindowEnd: string;               // ISO 8601, max 30 days from start
  query: string;                       // Search query
  maxResults: number;
}

interface LogsQueryResponse {
  summary: string;                     // Redacted, max 5000 chars
  matchCount: number;
  timeRange: { start: string; end: string };
  queryId: string;                     // For audit trail
}

interface LogsMCPConfig {
  serviceAllowlist: string[];
  maxTimeWindowDays: number;           // Default: 30
  maxResponseChars: number;            // Default: 5000
  redactionPatterns: RegExp[];         // IP, hostname, credential patterns
}
```

#### Grafana_MCP Interface

```typescript
interface GrafanaQueryRequest {
  dashboard: string;
  panel: string;
  timeRange: { from: string; to: string };
  variables: Record<string, string>;
}

interface GrafanaQueryResponse {
  summary: string;
  metrics: Array<{ name: string; value: number; unit: string }>;
  anomalies: string[];
  queryId: string;
}
```

#### GitHub_MCP Interface

```typescript
interface GitHubActionRequest {
  workflowName: string;               // Must be in workflow allowlist
  ref: string;                         // Branch/tag
  inputs: Record<string, string>;
}

interface GitHubActionResponse {
  runId: number;
  status: 'completed' | 'failed' | 'timeout' | 'cancelled';
  conclusion: string;
  summary: string;
  durationSeconds: number;
  queryId: string;
}

interface GitHubMCPConfig {
  workflowAllowlist: string[];
  pollIntervalSeconds: number;         // Default: 5
  timeoutSeconds: number;              // Default: 600
}
```

### 4. Skill_Analysis_Cronjob

Runs every 30 minutes (configurable). Scans un-analyzed session logs, proposes skill improvements via GitHub PRs.

#### Interface

```typescript
interface SkillAnalysisConfig {
  scheduleInterval: string;            // Cron expression, default: "*/30 * * * *"
  logsDirectory: string;               // Default: "~/.kiro/logs/"
  skillsDirectory: string;             // Path to Custom_Skill files
  targetRepo: string;                  // GitHub repo for PRs
  targetBranch: string;                // Branch for skill PRs
  cloudwatchLogGroup: string;
}

interface SkillAnalysisResult {
  sessionLogPath: string;
  matchedSkill: string | null;         // null = new skill proposed
  prNumber: number;
  prUrl: string;
  action: 'create' | 'update';
  metadata: {
    sessionTimestamp: string;
    incidentType: string;
    affectedSystems: string[];
  };
}

interface SkillAnalysisCronjobModule {
  scanForUnanalyzedLogs(dir: string): string[];
  analyzeSession(logPath: string, existingSkills: string[]): SkillAnalysisResult;
  createSkillPR(result: SkillAnalysisResult): Promise<number>;
  markAsAnalyzed(logPath: string): void;
  run(): Promise<void>;
}
```

### 5. Benchmark_Cronjob

Runs weekly (configurable). Aggregates session metrics, produces benchmark reports, alerts on regressions.

#### Interface

```typescript
interface SessionMetric {
  sessionId: string;
  timestamp: string;
  agentName: string;
  incidentType: string;
  skillsReferenced: string[];
  resolutionTimeSeconds: number;
  escalationNeeded: boolean;
  humanRating: 'useful' | 'not_useful' | 'skip' | 'pending';
  prNumber: number | null;
}

interface SkillBenchmark {
  skillName: string;
  timesReferenced: number;
  averageResolutionTime: number;
  escalationRate: number;              // 0.0 - 1.0
  humanApprovalRate: number;           // 0.0 - 1.0
}

interface BenchmarkReport {
  weekStart: string;
  weekEnd: string;
  skills: SkillBenchmark[];
  regressions: Array<{
    skillName: string;
    metric: string;
    previousValue: number;
    currentValue: number;
    changePercent: number;
  }>;
}

interface BenchmarkConfig {
  schedule: string;                    // Cron expression, default: weekly
  metricsDirectory: string;
  outputDirectory: string;
  regressionThreshold: number;         // Default: 0.20 (20%)
  retentionDays: number;               // Default: 90
  alertSlackChannel: string;
  cloudwatchLogGroup: string;
}

interface BenchmarkCronjobModule {
  collectMetrics(startDate: string, endDate: string): SessionMetric[];
  updateHumanRatings(metrics: SessionMetric[]): Promise<SessionMetric[]>;
  aggregateBySkill(metrics: SessionMetric[]): SkillBenchmark[];
  detectRegressions(current: SkillBenchmark[], previous: SkillBenchmark[]): BenchmarkReport['regressions'];
  generateReport(current: SkillBenchmark[], regressions: BenchmarkReport['regressions']): BenchmarkReport;
  alertRegressions(regressions: BenchmarkReport['regressions']): Promise<void>;
  run(): Promise<void>;
}
```

### 6. Configuration Manager

Handles loading, validation, and hot-reloading of configuration files across all components.

#### Interface

```typescript
interface ConfigManager {
  load(path: string): Record<string, unknown>;
  validate(config: Record<string, unknown>, schema: object): boolean;
  watch(path: string, callback: (newConfig: Record<string, unknown>) => void): void;
  getLastValidConfig(): Record<string, unknown>;
}
```

- On invalid config: logs error to CloudWatch, retains previous valid config
- Reload within 60 seconds via `fs.watch` or polling interval

### 7. CloudWatch Logger

Centralized logging module used by Slack Bot and Cronjobs.

#### Interface

```typescript
interface CloudWatchLogger {
  logError(error: Error, context?: Record<string, unknown>): Promise<void>;
  logInfo(message: string, context?: Record<string, unknown>): Promise<void>;
  logWarn(message: string, context?: Record<string, unknown>): Promise<void>;
}

// Error log entry structure
interface ErrorLogEntry {
  timestamp: string;
  level: 'ERROR' | 'WARN' | 'INFO';
  message: string;
  stackTrace?: string;
  requestContext?: {
    channelId?: string;
    threadTs?: string;
    userId?: string;
    component: string;
  };
}
```

### 7a. DynamoDB Session Store

Persists ACP session-to-Slack-thread mappings for crash recovery and process restart scenarios. Not used on the hot path — the in-memory Map in ACP Session Manager handles active lookups.

#### Table Design

```
Table: slack-kiro-sessions
PK:    THREAD#{channel_id}:{root_thread_ts}
       (No Sort Key — one thread maps to one session, 1:1)

Attributes:
  acp_session_id   (S)   — ACP session identifier
  agent_name       (S)   — "senior-agent" | "architect-agent"
  created_at       (N)   — epoch seconds
  last_active_at   (N)   — epoch seconds
  ttl              (N)   — epoch seconds, 90 days from last_active_at
```

#### Capacity & Cost

- On-Demand capacity mode
- Each record is a few hundred bytes — cost is negligible at expected volume

#### TTL

- 90 days from last activity, using DynamoDB's built-in TTL feature for automatic cleanup
- Suitable for long-running DevOps investigations
- Risk: ACP `session/load` may fail after extended periods due to kiro-cli version upgrades or session file cleanup — handled by graceful fallback to `session/new`

#### Interface

```typescript
interface DynamoSessionStore {
  get(sessionKey: string): Promise<SessionRecord | null>;
  put(record: SessionRecord): Promise<void>;
  updateActivity(sessionKey: string): Promise<void>;  // updates lastActiveAt + ttl
  delete(sessionKey: string): Promise<void>;
}
```

### 8. ACP Session Manager (`acp-session-manager.ts`)

Manages ACP session lifecycle, maps Slack threads to ACP sessions, enforces per-session locking, maintains request queues, and coordinates prompt execution and turn completion. Uses an in-memory Map as primary lookup and DynamoDB as persistence layer for crash recovery.

#### Interface

```typescript
// Durable state — persisted to DynamoDB
interface SessionRecord {
  pk: string;                          // "THREAD#{channel_id}:{root_thread_ts}"
  acpSessionId: string;
  agentName: 'senior-agent' | 'architect-agent';
  createdAt: number;                   // epoch seconds
  lastActiveAt: number;                // epoch seconds
  ttl: number;                         // epoch seconds, 90 days from lastActiveAt
}

// Full runtime state — in-memory only
interface SessionState {
  sessionKey: string;                  // channel_id + ":" + root_thread_ts
  acpSessionId: string;
  activeAgent: 'senior-agent' | 'architect-agent';
  inflight: boolean;                   // ephemeral, resets on restart
  queue: SessionRequest[];             // ephemeral, FIFO
  responseMode: 'thread_reply' | 'publish_channel'; // ephemeral
  statusMessageTs?: string;            // ephemeral
  lastUpdatedAt: string;
}

interface SessionRequest {
  messageText: string;
  channelId: string;
  threadTs: string;
  userId: string;
  timestamp: string;
}

interface ACPSessionManagerModule {
  getOrCreateSession(sessionKey: string): Promise<SessionState>;
  loadSession(sessionKey: string): Promise<SessionState | null>;
  recoverSession(sessionKey: string): Promise<SessionState | null>;
  enqueueRequest(sessionKey: string, request: SessionRequest): Promise<void>;
  processNext(sessionKey: string): Promise<void>;
  markInflight(sessionKey: string): void;
  releaseInflight(sessionKey: string): void;
  handleTurnEnd(sessionKey: string): Promise<void>;
}
```

#### Session Lookup Flow

```
incoming message for session_key
  → check in-memory Map
    → HIT: use cached SessionState
    → MISS: query DynamoDB by PK = "THREAD#{session_key}"
      → FOUND: attempt session/load with stored acpSessionId
        → session/load SUCCESS: populate in-memory cache, continue
        → session/load FAIL: fall back to session/new, update DynamoDB
      → NOT FOUND: session/new, write to DynamoDB, populate in-memory cache
```

#### Design Rules

- One session must only process one active turn at a time
- FIFO queue is required per session
- Session lock must be controlled at application layer
- ACP session identity must remain stable for the same Slack thread
- Recommended max concurrent active sessions: 2-4
- In-memory Map is the primary lookup — DynamoDB is only read on cache miss
- Ephemeral state (inflight, queue, statusMessageTs) is never persisted to DynamoDB
- `lastActiveAt` and `ttl` are updated in DynamoDB on each `session/prompt`

### 9. Agent Switch (`agent-switch.ts`)

Manages agent switching inside the same ACP session. Supports escalation from `senior-agent` to `architect-agent` without creating a new session.

#### Interface

```typescript
interface AgentSwitchModule {
  switchAgent(sessionId: string, agentName: 'senior-agent' | 'architect-agent'): Promise<void>;
  getActiveAgent(sessionKey: string): Promise<string | null>;
  escalateToArchitect(sessionKey: string): Promise<void>;
}
```

#### Agent Flow

```
senior-agent → architect-agent
```

#### Design Rules

- Agent switching must happen within the same ACP session
- Escalation must be explicitly triggered by routing logic or human request
- Slack Bot should not create a second session for architect review
- Agent switch should occur only when session state is valid
- If session is currently busy, escalation request should be queued

#### Fallback Behavior

```
Preferred:   session/set_mode
Fallback:    _kiro.dev/commands/execute → /agent swap architect-agent
```

### 10. Slack Stream Controller (`slack-stream-controller.ts`)

Manages Slack-side streaming output: aggregates ACP message chunks, converts tool updates into user-friendly status messages, and avoids Slack API rate-limit issues.

#### Interface

```typescript
interface ToolUpdate {
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  summary?: string;
}

interface SlackStreamControllerModule {
  createPlaceholder(channelId: string, threadTs?: string): Promise<string>;
  appendChunk(sessionKey: string, chunk: string): void;
  flush(sessionKey: string): Promise<void>;
  handleToolUpdate(sessionKey: string, update: ToolUpdate): Promise<void>;
  finalize(sessionKey: string, finalText: string): Promise<void>;
}
```

#### Behavior

- DO NOT post one Slack message per chunk
- DO buffer chunks and update existing message
- DO show meaningful progress messages
- DO finalize response at end of turn

#### Flushing Strategy

```
- Buffer chunks in memory
- Update Slack every 2-5 seconds
- Flush immediately on TurnEnd
```

#### Example Progress Messages

```
🟡 Investigating...
🔍 Checking logs...
📊 Checking Grafana...
⚙️ Running GitHub workflow...
🏗️ Architect reviewing investigation...
```

#### Design Rules

- Slack output must be aggregated
- Slack output must be rate-limited
- Placeholder message should be reused whenever possible
- Final response should replace temporary investigation status with a readable summary
- On TurnEnd, the controller SHALL assemble the accumulated session content (original prompt, tool calls, chunks, final summary) into the standard Session_Log markdown format and write it to `~/.kiro/logs/`

## Data Models

### Session Log File

Session logs are produced by two different execution paths but MUST use the same format and destination directory so the Skill_Analysis_Cronjob can process them uniformly.

#### Sources

```
ACP modes (auto_investigation, mention_based):
  → Slack Bot assembles session content from streaming output on TurnEnd
  → Writes to ~/.kiro/logs/[agent_name]-YYYY-MM-DD-HH-MM.md

Learning mode:
  → kiro-cli chat --no-interactive --agent senior-agent "<prompt>"
    > ~/.kiro/logs/senior-agent-YYYY-MM-DD-HH-MM.md 2>&1
  → stdout redirect produces the log directly
```

```
Path: ~/.kiro/logs/[agent_name]-YYYY-MM-DD-HH-MM.md
After analysis: ~/.kiro/logs/[agent_name]-YYYY-MM-DD-HH-MM-analyzed.md
```

Content structure (markdown):

```markdown
# Session: [agent_name] - [timestamp]

## Original Alert/Question
[Original message text from Slack]

## Triage
- Incident Type: [alert|investigation|validation|general_query]
- Escalated To: [Architect_Agent or none]

## Investigation Steps
1. [Step description]
   - Tool: [MCP tool used]
   - Query: [summarized query]
   - Result: [summarized finding]

## Findings
[Summary of findings]

## Hypotheses
- [Hypothesis 1]
- [Hypothesis 2]

## Resolution
[Recommended actions and resolution summary]
```

### Custom Skill File

```
Path: [skills_directory]/[domain]/[skill-name].md
Example: skills/aws-infra-issue/ec2-high-cpu.md
```

Domain-based organization:
- `aws-infra-issue/` — AWS infrastructure problems
- `application-issue/` — Application-level issues
- `deployment-issue/` — CI/CD and deployment problems
- `monitoring-issue/` — Monitoring and alerting problems

### Session Metric (JSON)

```json
{
  "sessionId": "senior-engineer-2026-03-15-14-30",
  "timestamp": "2026-03-15T14:30:00Z",
  "agentName": "Senior_Agent",
  "incidentType": "alert",
  "skillsReferenced": ["aws-infra-issue/ec2-high-cpu"],
  "resolutionTimeSeconds": 120,
  "escalationNeeded": false,
  "humanRating": "useful",
  "prNumber": 42
}
```

Stored at: `[metricsDirectory]/[sessionId].json`

### Skill Benchmark Report (Markdown)

```
Path: [outputDirectory]/benchmark-YYYY-MM-DD.md
```

Content structure:

```markdown
# Skill Benchmark Report — Week of [date]

## Summary
- Total sessions: [N]
- Skills evaluated: [N]
- Regressions detected: [N]

## Per-Skill Metrics

| Skill | Times Referenced | Avg Resolution (s) | Escalation Rate | Approval Rate |
|-------|-----------------|--------------------:|----------------:|--------------:|
| [name] | [N] | [N] | [%] | [%] |

## Regressions

| Skill | Metric | Previous | Current | Change |
|-------|--------|----------|---------|--------|
| [name] | [metric] | [val] | [val] | [+/-%] |
```

### Audit Log Entry

```typescript
interface AuditLogEntry {
  timestamp: string;
  requesterId: string;          // Slack user ID
  channelId: string;
  threadTs: string;
  action: string;               // e.g., "triage", "query_logs", "escalate", "trigger_workflow"
  component: string;            // e.g., "Logs_MCP", "GitHub_MCP"
  details: Record<string, unknown>;
  queryId: string;
}
```

### Configuration Files

#### Channel Allowlist (`config/channels.json`)

```json
{
  "channels": [
    {
      "channelId": "C01ABC123",
      "mode": "auto_investigation",
      "responseMode": "thread_reply"
    },
    {
      "channelId": "C02DEF456",
      "mode": "mention_based",
      "responseMode": "thread_reply"
    },
    {
      "channelId": "C03GHI789",
      "mode": "learning",
      "responseMode": "thread_reply"
    },
    {
      "channelId": "C04JKL012",
      "mode": "auto_investigation",
      "responseMode": "publish_channel",
      "publishChannelId": "C05MNO345"
    }
  ],
  "monitoredThreads": true
}
```

#### MCP Service Allowlist (`config/mcp-services.json`)

```json
{
  "logs": {
    "allowedServices": ["api-gateway", "auth-service", "payment-service"],
    "maxTimeWindowDays": 30,
    "maxResponseChars": 5000
  },
  "github": {
    "allowedWorkflows": ["validate-fix.yml", "smoke-test.yml"],
    "pollIntervalSeconds": 5,
    "timeoutSeconds": 600
  }
}
```

### Directory Structure

```
project-root/
├── src/
│   ├── slack-bot/
│   │   ├── app.ts                  # Bolt SDK app initialization
│   │   ├── events.ts               # Event handlers
│   │   ├── routing.ts              # Routing layer (mode + policy)
│   │   ├── sanitizer.ts            # Input sanitization
│   │   └── response-formatter.ts   # Slack message formatting
│   ├── acp/
│   │   ├── acp-session-manager.ts  # ACP state + lock + queue + session lifecycle
│   │   ├── session-store.ts        # DynamoDB session persistence + in-memory cache
│   │   ├── agent-switch.ts         # senior ↔ architect switching within same session
│   │   └── slack-stream-controller.ts # chunk aggregation + progress UI + final Slack output
│   ├── mcp-servers/
│   │   ├── logs-mcp/
│   │   ├── grafana-mcp/
│   │   └── github-mcp/
│   ├── cronjobs/
│   │   ├── skill-analysis.ts       # Skill_Analysis_Cronjob
│   │   └── benchmark.ts            # Benchmark_Cronjob
│   ├── config/
│   │   ├── manager.ts              # Config loading & hot-reload
│   │   ├── channels.json
│   │   └── mcp-services.json
│   ├── logging/
│   │   └── cloudwatch.ts           # CloudWatch logger
│   └── types/
│       └── index.ts                # Shared type definitions
├── agents/
│   ├── senior-agent/
│   └── architect-agent/
├── skills/
│   ├── aws-infra-issue/
│   ├── application-issue/
│   ├── deployment-issue/
│   └── monitoring-issue/
└── ~/.kiro/logs/                   # Session logs (runtime)
```

### Runtime Execution Order

```
ACP path (auto_investigation / mention_based):
  Slack event
    → routing decision (mode + policy)
    → acp-session-manager.ts (get/create session, acquire lock)
    → agent-switch.ts (if escalation needed)
    → ACP session/prompt execution
    → slack-stream-controller.ts (buffer chunks, progress UI)
    → TurnEnd → final Slack response + write Session_Log to ~/.kiro/logs/
    → release lock → dequeue next

Learning path:
  Slack event
    → routing decision (mode = learning)
    → spawn kiro-cli chat --no-interactive --agent senior-agent "<prompt>"
      > ~/.kiro/logs/senior-agent-YYYY-MM-DD-HH-MM.md 2>&1
    → fire-and-forget (no Slack response, no ACP session)
```
