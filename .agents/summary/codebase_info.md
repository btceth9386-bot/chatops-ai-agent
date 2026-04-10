# Codebase Information

## Project

- **Name:** chatops-ai-agent
- **Version:** 0.1.0
- **Language:** TypeScript (ES2022 target, CommonJS modules)
- **Runtime:** Node.js 24
- **Package manager:** npm
- **Test framework:** Vitest
- **Build:** `tsc` → `dist/`

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Slack SDK | `@slack/bolt` 4.x (Socket Mode) |
| AWS DynamoDB | `@aws-sdk/client-dynamodb` 3.x |
| AWS CloudWatch | `@aws-sdk/client-cloudwatch-logs` 3.x |
| Env loading | `dotenv` |
| Scheduling | `node-cron` |
| IaC | Terraform (AWS provider ~5.0) |
| CI | GitHub Actions |

## Repository Layout

```
src/
├── index.ts                  # Node entrypoint
├── types/index.ts            # All shared type definitions
├── config/
│   ├── app-config.ts         # Loads app.json with env overrides
│   └── manager.ts            # Channel config hot-reload
├── slack-bot/
│   ├── app.ts                # Slack Bolt bootstrap
│   ├── events.ts             # Slack event → internal event
│   ├── routing.ts            # Channel routing decisions
│   ├── sanitizer.ts          # Input sanitization
│   ├── session-runtime.ts    # Per-thread session orchestrator
│   ├── stream-controller.ts  # Slack message streaming
│   └── response-formatter.ts # Output formatting + splitting
├── acp/
│   └── process-manager.ts    # ACP child process + JSON-RPC
├── sessions/
│   └── store.ts              # DynamoDB / in-memory session store
└── logging/
    ├── logger.ts             # Console logger with levels
    └── cloudwatch.ts         # CloudWatch Logs wrapper

tests/                        # Mirrors src/ structure
terraform/                    # AWS infra (DynamoDB, IAM, CloudWatch)
scripts/                      # Dev/ops shell scripts
.github/workflows/            # CI pipeline
```

## Configuration Layers

1. `.env` — Secrets only (Slack tokens, signing secret). Gitignored.
2. `src/config/app.json` — Runtime config (port, CloudWatch, DynamoDB, ACP command). Committed.
3. `src/config/channels.json` — Channel routing policy. Gitignored (workspace-specific).

Any `app.json` value can be overridden by its corresponding environment variable.
