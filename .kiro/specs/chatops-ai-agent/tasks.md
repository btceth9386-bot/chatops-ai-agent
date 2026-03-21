# Implementation Plan: ChatOps AI Agent (v2 — ACP + Slack Integration)

## Overview

This plan implements the ChatOps AI Agent in three phases: (1) Core Slack Bot & ACP Infrastructure, (2) Learning & Skill Improvement, and (3) Benchmarking. Each phase builds incrementally on the previous, ensuring no orphaned code. All code is TypeScript (Node.js), using the Slack Bolt SDK and AWS SDK.

## Phase 1 — Core Slack Bot & ACP Infrastructure

- [ ] 1. Set up project structure, shared types, and configuration
  - [ ] 1.1 Create directory structure and initialize TypeScript project
    - Create `src/` directory tree as specified in design: `slack-bot/`, `acp/`, `mcp-servers/`, `cronjobs/`, `config/`, `logging/`, `types/`
    - Initialize `package.json` with dependencies: `@slack/bolt`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-cloudwatch-logs`, `node-cron`
    - Configure `tsconfig.json` with strict mode
    - _Requirements: 1.6, 4.1_

  - [ ] 1.2 Define shared type definitions in `src/types/index.ts`
    - Implement all interfaces from design: `SlackBotConfig`, `ChannelConfig`, `SlackEvent`, `SanitizedInput`, `SessionRecord`, `SessionState`, `SessionRequest`, `SafeSummary`, `TriageResult`, `ToolUpdate`, `AgentName`, `AgentConfig`, `AuditLogEntry`, `ErrorLogEntry`, `SessionMetric`, `SkillBenchmark`, `BenchmarkReport`, `BenchmarkConfig`, `SkillAnalysisConfig`, `SkillAnalysisResult`
    - _Requirements: 1.5, 4a.1, 4a.6, 9.1–9.5, 14.2, 19.1–19.9_

  - [ ] 1.3 Implement Configuration Manager (`src/config/manager.ts`)
    - Implement `load()`, `validate()`, `watch()`, `getLastValidConfig()` per design interface
    - Support hot-reload via `fs.watch` or polling (within 60 seconds)
    - On invalid config: log error, retain previous valid config
    - _Requirements: 13.1–13.5_

  - [ ] 1.4 Create default configuration files
    - Create `src/config/channels.json` with channel allowlist structure (learning, auto_investigation, mention_based modes, responseMode per channel)
    - Create `src/config/mcp-services.json` with logs and GitHub allowlist structure
    - _Requirements: 13.1–13.3, 14a.5_

  - [ ]* 1.5 Write unit tests for Configuration Manager
    - Test load, validate, hot-reload, and invalid config fallback
    - _Requirements: 13.1–13.5_

- [ ] 2. Implement CloudWatch Logger and Input Sanitizer
  - [ ] 2.1 Implement CloudWatch Logger (`src/logging/cloudwatch.ts`)
    - Implement `logError()`, `logInfo()`, `logWarn()` per design interface
    - Include timestamp, level, message, stackTrace, and requestContext in log entries
    - Use `@aws-sdk/client-cloudwatch-logs` for CloudWatch integration
    - Support configurable log group via environment variable
    - _Requirements: 2.1–2.5_

  - [ ] 2.2 Implement Input Sanitizer (`src/slack-bot/sanitizer.ts`)
    - Implement `sanitizeInput()` that strips control characters and enforces 10000 char limit
    - Return `SanitizedInput` with `wasTruncated` flag and `originalLength`
    - Append truncation notice when message exceeds limit
    - _Requirements: 3.1–3.4_

  - [ ]* 2.3 Write unit tests for Input Sanitizer
    - Test control character removal, truncation at 10000 chars, truncation notice appended, normal input passthrough
    - _Requirements: 3.1–3.4_

- [ ] 3. Implement Slack Bot core (Bolt SDK, event handling, routing)
  - [ ] 3.1 Implement Bolt SDK app initialization (`src/slack-bot/app.ts`)
    - Initialize Bolt SDK app with `slackBotToken`, `slackAppToken`, `slackSigningSecret`
    - Load channel allowlist config at startup
    - Register event listeners for `app_mention` and `message` events
    - Wire up CloudWatch logger for Bolt SDK errors, connection errors, auth failures, API errors
    - _Requirements: 1.1–1.6, 2.3–2.4_

  - [ ] 3.2 Implement Routing Layer (`src/slack-bot/routing.ts`)
    - Implement `isChannelAllowed()` and `getChannelConfig()` per design interface
    - Route events based on channel mode: `learning`, `auto_investigation`, `mention_based`
    - For `learning` mode: spawn `kiro-cli chat --no-interactive --agent senior-agent "<prompt>"` with stdout redirected to `~/.kiro/logs/`, fire-and-forget, no ACP session, no Slack response
    - For `auto_investigation` mode: automatically delegate to ACP Session Manager
    - For `mention_based` mode: require `app_mention` event before delegating to ACP Session Manager
    - Detect escalation commands (`escalate`, `architect`) and route to Agent Switch module
    - _Requirements: 14a.1–14a.6_

  - [ ] 3.3 Implement Event Handlers (`src/slack-bot/events.ts`)
    - Handle `app_mention` events: extract message text, channel ID, thread ID, user ID
    - Handle `message` events for monitored threads
    - Validate channel against allowlist before processing
    - Sanitize input via sanitizer module
    - Acknowledge receipt within 6 seconds (Bolt SDK `ack()`)
    - Delegate to routing layer for mode-based handling
    - _Requirements: 1.1–1.5, 3.1, 12.3_

  - [ ] 3.4 Implement Response Formatter (`src/slack-bot/response-formatter.ts`)
    - Format Safe_Summary using Slack markdown (mrkdwn)
    - Split messages exceeding Slack message limits into multiple messages
    - Support `thread_reply` and `publish_channel` response modes
    - For `publish_channel`: include permalink to original message as title
    - _Requirements: 9.1–9.5, 10.7–10.8, 14b.1–14b.4_

  - [ ]* 3.5 Write unit tests for Routing Layer
    - Test channel allowlist validation, mode-based routing decisions, escalation command detection
    - _Requirements: 14a.1–14a.6_

- [ ] 4. Checkpoint — Slack Bot core
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Implement ACP Runtime and Session Management
  - [ ] 5.1 Implement DynamoDB Session Store (`src/acp/session-store.ts`)
    - Implement `get()`, `put()`, `updateActivity()`, `delete()` per design interface
    - Use `@aws-sdk/client-dynamodb` with table name `slack-kiro-sessions`
    - PK format: `THREAD#{channel_id}:{root_thread_ts}`
    - Set TTL to 90 days from `lastActiveAt`
    - Maintain in-memory Map as primary lookup cache
    - Read DynamoDB only on cache miss (process restart scenario)
    - _Requirements: 4a.1–4a.9_

  - [ ] 5.2 Implement ACP Session Manager (`src/acp/acp-session-manager.ts`)
    - Spawn single long-lived `kiro-cli acp` process via `child_process.spawn` at startup, communicate over stdio (JSON-RPC 2.0, line-delimited)
    - Implement `getOrCreateSession()`: check in-memory Map → DynamoDB fallback → `session/new` if not found
    - Implement `recoverSession()`: attempt `session/load` with stored `acpSessionId`, fall back to `session/new` on failure, update DynamoDB
    - Implement per-session FIFO queue and `inflight` lock: `enqueueRequest()`, `processNext()`, `markInflight()`, `releaseInflight()`
    - Implement `handleTurnEnd()`: release lock, dequeue and process next request
    - Enforce configurable max concurrent active sessions (default: 4)
    - On ACP process crash: restart process, log event, return error to Slack
    - Update `lastActiveAt` and `ttl` in DynamoDB on each `session/prompt`
    - _Requirements: 4.1–4.6, 4a.1–4a.9, 4a-1.1–4a-1.5, 4b.1–4b.5, 12.5–12.6_

  - [ ] 5.3 Implement Agent Switch (`src/acp/agent-switch.ts`)
    - Implement `switchAgent()` using `session/set_mode` as preferred method
    - Implement fallback via `_kiro.dev/commands/execute` with `/agent swap architect-agent`
    - Implement `escalateToArchitect()`: switch agent within same ACP session, no new session creation
    - If session is busy (inflight), enqueue escalation request in FIFO queue
    - _Requirements: 6.1–6.9_

  - [ ]* 5.4 Write unit tests for DynamoDB Session Store
    - Test get/put/updateActivity/delete operations, in-memory cache behavior, TTL calculation
    - _Requirements: 4a.1–4a.9_

  - [ ]* 5.5 Write unit tests for ACP Session Manager
    - Test session creation, recovery flow (session/load success and failure), FIFO queue ordering, inflight lock, max concurrent sessions enforcement
    - _Requirements: 4.1–4.6, 4a-1.1–4a-1.5, 4b.1–4b.5_

- [ ] 6. Implement Slack Stream Controller and Session Logging
  - [ ] 6.1 Implement Slack Stream Controller (`src/acp/slack-stream-controller.ts`)
    - Implement `createPlaceholder()`: post initial placeholder message in Slack thread
    - Implement `appendChunk()`: buffer `AgentMessageChunk` notifications in memory
    - Implement `flush()`: update placeholder message with buffered content every 2-5 seconds
    - Implement `handleToolUpdate()`: render tool status as user-friendly messages (🔍 Checking logs..., 📊 Checking Grafana..., ⚙️ Running GitHub workflow...)
    - Implement `finalize()`: flush final content, replace placeholder with complete Safe_Summary on `TurnEnd`
    - Retry Slack post failures up to 3 times with exponential backoff
    - Reuse placeholder message for updates to minimize Slack API calls
    - _Requirements: 10.1–10.10, 12.7_

  - [ ] 6.2 Implement Session Log Writer
    - On `TurnEnd` in ACP modes: assemble session content from accumulated streaming output (original prompt, tool calls, chunks, final summary) into standard Session_Log markdown format
    - Write to `~/.kiro/logs/[agent_name]-YYYY-MM-DD-HH-MM.md`
    - Create `~/.kiro/logs/` directory if it does not exist
    - Ensure same markdown format as learning mode logs (original alert, triage, investigation steps, findings, hypotheses, resolution)
    - _Requirements: 14.1–14.5_

  - [ ]* 6.3 Write unit tests for Slack Stream Controller
    - Test chunk buffering, flush interval, tool update rendering, finalize behavior, retry logic
    - _Requirements: 10.1–10.10_

- [ ] 7. Implement MCP Server interfaces
  - [ ] 7.1 Implement Logs MCP client (`src/mcp-servers/logs-mcp/`)
    - Enforce service allowlist validation
    - Limit query time windows to 30 days maximum
    - Redact sensitive data patterns (IP, hostname, credential patterns)
    - Return summarized results not exceeding 5000 characters
    - Record all queries in Audit_Log
    - _Requirements: 7.1–7.5_

  - [ ] 7.2 Implement Grafana MCP client (`src/mcp-servers/grafana-mcp/`)
    - Query dashboards and panels with time range and variables
    - Return summary, metrics, and anomalies
    - _Requirements: 5.3, 6.7_

  - [ ] 7.3 Implement GitHub MCP client (`src/mcp-servers/github-mcp/`)
    - Validate workflow name against allowlist
    - Trigger GitHub Actions workflows
    - Poll for completion with 5-second intervals
    - Return status and summary on completion; return timeout status after 600 seconds
    - Record all workflow triggers in Audit_Log
    - _Requirements: 8.1–8.6_

  - [ ]* 7.4 Write unit tests for MCP server clients
    - Test allowlist enforcement, redaction patterns, time window limits, polling and timeout behavior
    - _Requirements: 7.1–7.5, 8.1–8.6_

- [ ] 8. Implement Error Handling and wire everything together
  - [ ] 8.1 Implement error handling across all components
    - ACP process crash/unresponsive: restart and return error message to Slack
    - MCP server unreachable: return error indicating which service is unavailable
    - Query returns no results: return message indicating no relevant data found
    - GitHub Actions trigger failure: return error with failure reason
    - Never expose stack traces or internal error details in Slack messages
    - _Requirements: 11.1–11.5_

  - [ ] 8.2 Wire all Phase 1 components together in `src/slack-bot/app.ts`
    - Connect event handlers → routing → ACP session manager → stream controller → response formatter
    - Initialize ACP process at startup
    - Initialize DynamoDB session store
    - Initialize config manager with hot-reload
    - Initialize CloudWatch logger
    - Ensure end-to-end flow: Slack event → sanitize → route → ACP session → stream → respond
    - _Requirements: 1.1–1.6, 4.1–4.6, 10.1–10.10, 12.1–12.7_

  - [ ]* 8.3 Write integration tests for end-to-end Slack → ACP → Response flow
    - Test auto_investigation mode: message → ACP session → streaming → final response in thread
    - Test mention_based mode: mention → ACP session → response
    - Test learning mode: message → kiro-cli chat spawn → log file created
    - Test escalation flow: escalation command → agent switch within same session
    - Test session recovery: simulate restart → DynamoDB lookup → session/load or session/new fallback
    - _Requirements: 4.1–4.6, 4a-1.1–4a-1.5, 14a.1–14a.6_

- [ ] 9. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.

## Phase 2 — Learning & Skill Improvement

- [ ] 10. Implement Skill Analysis Cronjob
  - [ ] 10.1 Implement log scanning (`src/cronjobs/skill-analysis.ts`)
    - Implement `scanForUnanalyzedLogs()`: scan `~/.kiro/logs/` for files without `-analyzed` suffix
    - Process each un-analyzed Session_Log sequentially to avoid race conditions
    - _Requirements: 15.1–15.3_

  - [ ] 10.2 Implement session analysis and skill matching
    - Implement `analyzeSession()`: analyze Session_Log content against existing Custom_Skill files in skills directory
    - If session content semantically matches an existing Custom_Skill: propose update to that skill
    - If no match: propose a new skill file
    - Extract `SessionMetric` from each Session_Log during analysis (incident_type, skills_referenced, resolution_time_seconds, escalation_needed, agent_name)
    - Parse incident_type from original alert/question in Session_Log
    - Identify skills_referenced by scanning for Custom_Skill file references
    - Calculate resolution_time_seconds from file creation to last-modified timestamp
    - Detect escalation_needed from delegation patterns in Session_Log
    - Store Session_Metric as JSON in configurable metrics directory
    - _Requirements: 15.4–15.6, 19.1–19.6, 19.8–19.9_

  - [ ] 10.3 Implement PR creation and log marking
    - Implement `createSkillPR()`: use `gh` CLI to create Skill_Improvement_PR with proposed skill changes
    - PR description SHALL include: summary of session findings, file path to Session_Log
    - PR SHALL include metadata: session timestamp, incident type, affected systems, whether PR creates new skill or updates existing
    - PR SHALL target designated skills repository/branch
    - Implement `markAsAnalyzed()`: rename file by appending `-analyzed` to filename
    - Log execution status and errors to CloudWatch_LogGroup
    - _Requirements: 15.7–15.12_

  - [ ] 10.4 Implement cronjob runner with `node-cron`
    - Implement `run()`: orchestrate scan → analyze → PR → mark flow
    - Schedule on configurable interval (default: every 30 minutes via `*/30 * * * *`)
    - _Requirements: 15.1_

  - [ ]* 10.5 Write unit tests for Skill Analysis Cronjob
    - Test log scanning (filters out `-analyzed` files), skill matching logic, PR creation call, file renaming, metric extraction
    - _Requirements: 15.1–15.12, 19.1–19.6_

- [ ] 11. Implement Skill Repository Management and Integration
  - [ ] 11.1 Set up skills directory structure
    - Create domain-based skill directories: `skills/aws-infra-issue/`, `skills/application-issue/`, `skills/deployment-issue/`, `skills/monitoring-issue/`
    - Ensure Custom_Skill files are stored in markdown format
    - _Requirements: 18.1–18.2_

  - [ ] 11.2 Implement skill integration on PR merge
    - Detect merge events (via webhook or polling)
    - Extract skill updates from merged PR content
    - Update relevant Custom_Skill files in skills directory
    - Validate updated skill syntax before applying
    - On validation failure: log error and revert to previous skill version
    - Commit changes with descriptive message
    - _Requirements: 17.1–17.5, 18.3–18.5_

  - [ ] 11.3 Implement human review workflow support
    - Ensure Skill_Improvement_PRs are created in review-required state
    - Notify designated reviewers via GitHub
    - Prevent auto-merging without human approval (branch protection rules)
    - _Requirements: 16.1–16.5_

  - [ ]* 11.4 Write unit tests for skill integration
    - Test skill file update, syntax validation, revert on failure, commit message format
    - _Requirements: 17.1–17.5_

- [ ] 12. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.

## Phase 3 — Benchmarking

- [ ] 13. Implement Benchmark Cronjob
  - [ ] 13.1 Implement metrics collection and human rating updates (`src/cronjobs/benchmark.ts`)
    - Implement `collectMetrics()`: read Session_Metric JSON files from metrics directory for the specified date range
    - Implement `updateHumanRatings()`: query GitHub PR statuses via `gh` CLI to derive human_rating (merged = useful, closed without merge = not_useful, open > 7 days = skip)
    - _Requirements: 19.6–19.7, 20.2_

  - [ ] 13.2 Implement skill aggregation and regression detection
    - Implement `aggregateBySkill()`: compute per-skill metrics (times_referenced, average_resolution_time, escalation_rate, human_approval_rate)
    - Implement `detectRegressions()`: compare current week against previous week; flag skill as regressed if escalation_rate increases or average_resolution_time increases by more than 20%
    - _Requirements: 20.2–20.5_

  - [ ] 13.3 Implement report generation
    - Implement `generateReport()`: produce Skill_Benchmark_Report in markdown format with summary, per-skill metrics table, and regressions table
    - Save report to configurable output directory as `benchmark-YYYY-MM-DD.md`
    - Support querying reports by skill name, incident type, and time range
    - Retain reports for 90 days minimum
    - _Requirements: 20.3, 20.6, 21.3–21.4_

  - [ ] 13.4 Implement regression alerting
    - Implement `alertRegressions()`: send Slack notification to configurable alert channel when regressions detected
    - Notification SHALL include: skill name, regression metrics, link to Skill_Benchmark_Report
    - _Requirements: 21.1–21.2_

  - [ ] 13.5 Implement cronjob runner with `node-cron`
    - Implement `run()`: orchestrate collect → update ratings → aggregate → detect regressions → generate report → alert flow
    - Schedule on configurable interval (default: weekly)
    - Log execution status and errors to CloudWatch_LogGroup
    - _Requirements: 20.1, 21.5_

  - [ ]* 13.6 Write unit tests for Benchmark Cronjob
    - Test metrics collection, human rating derivation from PR status, aggregation math, regression detection threshold (20%), report markdown format, alert message content
    - _Requirements: 20.1–20.6, 21.1–21.5_

- [ ] 14. Final checkpoint — All phases complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at the end of each phase
- All code is TypeScript targeting Node.js runtime
- The design specifies all interfaces — implementation should follow them closely
- Phase 1 must be fully functional before Phase 2 begins (Phase 2 depends on session logs from Phase 1)
- Phase 3 depends on session metrics produced by Phase 2's Skill Analysis Cronjob
