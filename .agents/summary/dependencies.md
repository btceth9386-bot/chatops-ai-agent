# Dependencies

## Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@slack/bolt` | ^4.4.0 | Slack app framework (Socket Mode, event handling, Web API) |
| `@aws-sdk/client-dynamodb` | ^3.888.0 | DynamoDB session persistence |
| `@aws-sdk/client-cloudwatch-logs` | ^3.888.0 | Structured logging to CloudWatch |
| `dotenv` | ^17.3.1 | Auto-load `.env` at startup |
| `node-cron` | ^4.2.1 | Scheduled tasks (imported but not yet actively used in core flow) |

## Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.9.2 | TypeScript compiler |
| `@types/node` | ^24.5.2 | Node.js type definitions |
| `vitest` | ^3.2.4 | Test runner |

## External Services

| Service | Usage | Configuration |
|---------|-------|--------------|
| Slack API | Bot events (Socket Mode), message posting/updating | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` |
| AWS DynamoDB | Session state persistence | `DYNAMODB_TABLE_NAME`, `AWS_REGION` |
| AWS CloudWatch Logs | Structured application logging | `CLOUDWATCH_LOG_GROUP`, `CLOUDWATCH_LOG_STREAM` |
| kiro-cli ACP | AI agent backend (JSON-RPC over stdio) | `ACP_COMMAND` |

## Infrastructure (Terraform)

The `terraform/` directory provisions:

| Resource | File | Description |
|----------|------|-------------|
| DynamoDB table | `dynamodb.tf` | Session store with GSI on `acpSessionId`, TTL, PITR |
| IAM role + user | `iam.tf` | Scoped DynamoDB + CloudWatch permissions, EC2 trust |
| CloudWatch log group | `cloudwatch.tf` | App log group with configurable retention |
| Provider config | `main.tf` | AWS provider ~5.0, default tags |

## MCP Servers (External)

Registered with `kiro-cli` via `~/.kiro/settings/mcp.json`. The Slack bot does not call them directly — they are invoked by the ACP runtime.

Included server templates (from `mcp.json.example`): OpenSearch, Grafana AMG, EKS, Thanos (Prometheus), GitHub, AWS Documentation.
