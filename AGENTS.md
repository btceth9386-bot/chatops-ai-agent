# AGENTS.md — ChatOps AI Agent

> Slack bot that bridges conversations to a `kiro-cli acp` backend via JSON-RPC over stdio. TypeScript, Node.js 24, CommonJS.

## Phase Status

The specs (`.kiro/specs/chatops-ai-agent/`) define three phases. Current state:

| Phase | Scope | Status |
|-------|-------|--------|
| 1 — Core Slack Bot & ACP Infrastructure | Event handling, routing, ACP session management, streaming, DynamoDB persistence, agent switching | ✅ Implemented |
| 2 — Learning & Skill Improvement | Skill analysis cronjob, session log assembly on TurnEnd, skill PRs, tool permission whitelist | ❌ Not started |
| 3 — Benchmarking | Benchmark cronjob, session metrics, regression detection, Slack alerting | ❌ Not started |

Types for Phase 2/3 features already exist in `src/types/index.ts` (e.g., `SafeSummary`, `TriageResult`, `SessionMetric`, `SkillBenchmark`, `BenchmarkReport`, `SkillAnalysisConfig`, `SkillAnalysisResult`). These are aspirational — no runtime code uses them yet.

## Design ↔ Implementation Mapping

The design doc (`.kiro/specs/chatops-ai-agent/design.md`) uses different file names than what was built:

| Design file | Actual implementation | Notes |
|-------------|----------------------|-------|
| `acp/acp-session-manager.ts` | `slack-bot/session-runtime.ts` | FIFO queue, inflight lock, ACP dispatch |
| `acp/session-store.ts` | `sessions/store.ts` | Moved to its own `sessions/` directory |
| `acp/agent-switch.ts` | `acp/process-manager.ts` | Merged into `AcpProcessManager.switchAgent()` |
| `acp/slack-stream-controller.ts` | `slack-bot/stream-controller.ts` | Moved under `slack-bot/` |
| (not in design) | `slack-bot/session-runtime.ts` | New file — the core orchestrator that the design split across multiple files |

## Directory Map

```
src/
├── index.ts                     # Entrypoint: dotenv → loadAppConfig → startSlackApp
├── types/index.ts               # All shared types (also contains aspirational types for future phases)
├── config/
│   ├── app-config.ts            # Loads app.json, every field overridable via env var
│   └── manager.ts               # channels.json hot-reload via fs.watch
├── slack-bot/
│   ├── app.ts                   # Bolt bootstrap, MCP/skill loading, wires all components
│   ├── events.ts                # Raw Slack event → SlackEvent → routing dispatch
│   ├── routing.ts               # RoutingLayer: channel allowlist, mode decisions, command detection
│   ├── sanitizer.ts             # Strip control chars, truncate at maxMessageLength
│   ├── session-runtime.ts       # ★ Core orchestrator: FIFO queue, inflight lock, ACP dispatch
│   ├── stream-controller.ts     # Slack placeholder → throttled deltas → final message
│   └── response-formatter.ts    # SafeSummary formatting, byte-aware message splitting
├── acp/
│   └── process-manager.ts       # ★ ACP child process lifecycle + JSON-RPC protocol
├── sessions/
│   └── store.ts                 # SessionStore interface, DynamoDB + InMemory implementations
└── logging/
    ├── logger.ts                # Tagged console logger with levels
    └── cloudwatch.ts            # CloudWatch Logs wrapper

scripts/
├── restart-clean.sh             # Kill stale processes, start fresh (preferred local entrypoint)
├── setup-mcp.sh                 # Interactive MCP server credential setup
├── acp-rpc-test.sh              # Manual JSON-RPC testing harness
└── new_branch.sh                # Git branch helper

terraform/                       # DynamoDB table, IAM role/user, CloudWatch log group
```

## Architecture at a Glance

**Message flow:** Slack event → `events.ts` (sanitize + normalize) → `routing.ts` (decide action) → `session-runtime.ts` (queue + lock + dispatch) → `process-manager.ts` (JSON-RPC to `kiro-cli acp`) → streaming deltas back through `stream-controller.ts` → Slack.

**Key invariant:** One inflight ACP request per Slack thread at a time. Additional messages queue behind it (FIFO). Locking uses a promise-chain pattern — no external mutex library.

**Session persistence:** `THREAD#{channelId}:{threadTs}` → DynamoDB (prod) or in-memory Map (dev). GSI on `acpSessionId` for reverse lookups. 90-day TTL.

## ACP Protocol Surface

The app speaks JSON-RPC 2.0 over stdio to `kiro-cli acp`:

- `initialize` → one-time handshake
- `session/new` → create session (mode set via `session/set_mode` after)
- `session/load` → restore session from ID (30s timeout, falls back to `session/new`)
- `session/prompt` → send user message
- `session/set_mode` → switch agent (`senior` ↔ `architect`), with `_kiro.dev/commands/execute` fallback
- `session/update` notifications → `agent_message_chunk` deltas accumulated in buffer
- `session/request_permission` → auto-approved

## Patterns That Deviate from Defaults

- **No Express/HTTP server** — Uses Slack Socket Mode exclusively, no HTTP listener despite `PORT` config existing
- **CommonJS** — `"type": "commonjs"` in package.json, `"module": "CommonJS"` in tsconfig, despite ES2022 target
- **Three-layer config** — `.env` (secrets, gitignored) → `app.json` (runtime, committed) → `channels.json` (routing, gitignored). Any `app.json` value overridable via env var
- **channels.json is gitignored** — Contains workspace-specific Slack channel IDs. Copy from `channels.json.example`
- **Transport recycling** — On `session/load` failure, the entire ACP child process is killed and respawned rather than attempting recovery
- **Dual promise-chain locks** — `session-runtime.ts` uses two separate lock maps: `perSessionLocks` (serializes enqueue/processNext per Slack thread) and `perAcpEventLocks` (serializes ACP event handling per ACP session ID). No external mutex library
- **Aspirational types** — `src/types/index.ts` contains interfaces for features not yet implemented (`SafeSummary`, `TriageResult`, `SessionMetric`, `SkillBenchmark`, etc.)

## Config Discovery

| File | What it tells you |
|------|------------------|
| `.github/workflows/ci-test.yml` | CI runs `npm test` + `npm run build` on Node 24, triggers on push to `main`/`feat/**` and PRs |
| `tsconfig.json` | ES2022 target, CommonJS modules, strict mode, `vitest/globals` types |
| `.gitignore` | `dist/`, `.env`, `channels.json`, `.kiro/settings/mcp.json` are gitignored |
| `.env.example` | Full list of env var overrides |
| `terraform/` | AWS resources: DynamoDB table (PAY_PER_REQUEST, GSI, TTL, PITR), IAM role scoped to DynamoDB + CloudWatch, CloudWatch log group |
| `.kiro/settings/mcp.json.example` | MCP server templates: OpenSearch, Grafana, EKS, Thanos, GitHub, AWS Docs |

## Scripts

| Script | When to use |
|--------|------------|
| `npm run restart:clean` | Preferred local dev start — kills stale processes first |
| `scripts/setup-mcp.sh` | Interactive setup for `~/.kiro/settings/mcp.json` |
| `scripts/acp-rpc-test.sh` | Manual JSON-RPC testing against `kiro-cli acp` |

## Detailed Documentation

See `.agents/summary/index.md` for a full documentation index with file-by-file summaries covering architecture, components, interfaces, data models, workflows, dependencies, and review notes.

## Custom Instructions
<!-- This section is for human and agent-maintained operational knowledge.
     Add repo-specific conventions, gotchas, and workflow rules here.
     This section is preserved exactly as-is when re-running codebase-summary. -->
