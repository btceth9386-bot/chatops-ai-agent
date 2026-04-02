# Requirements Document

## Introduction

The ChatOps AI Agent system is an internal AI-powered DevOps/SRE assistant that monitors Slack channels and operational alerts, performs intelligent incident triage, queries internal systems through secure interfaces, and provides safe summarized responses back to Slack. The system prioritizes security by preventing raw log exposure and enforcing controlled data access through a multi-layered architecture.

## Glossary

- **Slack_Bot**: Node.js + TypeScript application built with Slack Bolt SDK that listens to Slack events, enforces security policies, routes requests to the ACP runtime, and manages streaming output to Slack
- **Kiro_CLI_ACP**: AI agent runtime running as a single long-lived `kiro-cli acp` process that manages sessions, agents, and MCP tool integration via the Agent Client Protocol
- **ACP_Session**: A logical session within the ACP process, mapped 1:1 to a Slack thread. Identified by `session_key = channel_id + ":" + root_thread_ts`
- **Senior_Agent**: Default agent that receives all requests, performs investigation, triage, and generates Safe_Summary responses
- **Architect_Agent**: Agent that handles deeper analysis and remediation validation, activated only by explicit human escalation within the same ACP session
- **MCP_Server**: Model Context Protocol server that provides secure, summarized access to internal systems
- **Logs_MCP**: MCP server for querying internal log systems
- **Grafana_MCP**: MCP server for querying Grafana monitoring data
- **GitHub_MCP**: MCP server for triggering and monitoring GitHub Actions
- **Safe_Summary**: Redacted, summarized output that contains no raw sensitive data
- **Channel_Allowlist**: List of approved Slack channels where the bot is permitted to operate
- **Audit_Log**: Record of all agent operations including requester, tools used, and actions taken
- **Session_Key**: Unique identifier for an ACP session, composed of `channel_id + ":" + root_thread_ts`
- **Session_State**: Runtime state for an ACP session, split into two layers: (1) durable state persisted to DynamoDB_Session_Store (acp_session_id, agent_name, created_at, last_active_at, ttl) and (2) ephemeral state held in-memory only (inflight, queue, statusMessageTs, responseMode)
- **Session_Lock**: Per-session mutex ensuring only one prompt is in-flight per ACP session at a time
- **Session_Log**: Markdown-formatted record of an agent investigation session including context, analysis, and resolution
- **DynamoDB_Session_Store**: DynamoDB table (`slack-kiro-sessions`) that persists ACP session mappings for crash recovery and process restart. Uses in-memory cache as primary lookup, DynamoDB as persistence layer. Records auto-expire via TTL after 90 days of inactivity
- **Streaming_Buffer**: In-memory buffer that aggregates ACP `AgentMessageChunk` notifications before flushing to Slack at controlled intervals
- **Placeholder_Message**: Initial Slack message created when a request starts processing, reused for streaming updates and final response
- **Routing_Layer**: Slack Bot component that determines how to handle an event based on channel mode (learning, auto-investigation, mention-based) and policy
- **Skill_Improvement_PR**: GitHub pull request containing proposed updates to custom skills based on successful sessions
- **CloudWatch_LogGroup**: AWS CloudWatch log group where Slack_Bot errors and operational logs are stored
- **Bolt_SDK**: Slack Bolt for JavaScript SDK (https://github.com/slackapi/bolt-js) used to build the Slack_Bot
- **Session_Metric**: Structured record of session performance data including resolution time, skills used, and escalation status
- **Skill_Benchmark_Report**: Periodic aggregation of Session_Metrics per skill measuring effectiveness over time
- **Benchmark_Cronjob**: Scheduled job that periodically aggregates session data and produces Skill_Benchmark_Reports
- **Skill_Analysis_Cronjob**: Scheduled job that periodically scans un-analyzed session logs, creates skill improvement PRs, and marks logs as analyzed

## Requirements

### Requirement 1: Slack Event Monitoring

**User Story:** As a DevOps engineer, I want the system to monitor Slack channels for mentions and alerts, so that I can get AI-assisted help with operational issues.

#### Acceptance Criteria

1. WHEN a message mentions the bot in an allowed channel, THE Slack_Bot SHALL receive the event within 5 seconds
2. WHEN a message is posted in a monitored thread, THE Slack_Bot SHALL receive the event within 5 seconds
3. THE Slack_Bot SHALL maintain a Channel_Allowlist of permitted channels
4. WHEN a message is received from a channel not in the Channel_Allowlist, THE Slack_Bot SHALL ignore the message
5. THE Slack_Bot SHALL extract the message text, channel ID, thread ID, and user ID from each event
6. THE Slack_Bot SHALL be built using the Bolt_SDK (Slack Bolt for JavaScript)

### Requirement 2: Slack Bot Error Logging

**User Story:** As a DevOps engineer, I want all Slack bot errors logged to CloudWatch, so that I can monitor and troubleshoot bot issues.

#### Acceptance Criteria

1. WHEN the Slack_Bot encounters an error, THE Slack_Bot SHALL log the error to a CloudWatch_LogGroup
2. THE error log SHALL include timestamp, error message, stack trace, and request context
3. THE Slack_Bot SHALL log Bolt_SDK errors to the CloudWatch_LogGroup
4. THE Slack_Bot SHALL log connection errors, authentication failures, and API errors to the CloudWatch_LogGroup
5. THE CloudWatch_LogGroup SHALL be configurable via environment variable or configuration file

### Requirement 3: Input Sanitization

**User Story:** As a security engineer, I want all user inputs sanitized before processing, so that injection attacks are prevented.

#### Acceptance Criteria

1. WHEN the Slack_Bot receives a message, THE Slack_Bot SHALL sanitize the input before passing it to Kiro_CLI_ACP
2. THE Slack_Bot SHALL remove control characters from message text
3. THE Slack_Bot SHALL limit message length to 10000 characters
4. IF a message exceeds 10000 characters, THEN THE Slack_Bot SHALL truncate it and append a truncation notice

### Requirement 4: ACP Runtime Management

**User Story:** As a DevOps engineer, I want the Slack bot to use a persistent ACP process for AI agent execution, so that requests are handled efficiently without per-request process spawning overhead.

#### Acceptance Criteria

1. WHEN the Slack_Bot starts, THE Slack_Bot SHALL spawn a single long-lived `kiro-cli acp` process
2. THE Slack_Bot SHALL initialize the ACP process once at startup and reuse it for all subsequent requests
3. THE Slack_Bot SHALL NOT spawn a new `kiro-cli` process per request
4. WHEN the Slack_Bot receives a valid sanitized message, THE Slack_Bot SHALL route it to the ACP process via `session/prompt`
5. THE Slack_Bot SHALL pass the channel ID, thread ID, user ID, and message text as context to the ACP session
6. IF the ACP process crashes or becomes unresponsive, THEN THE Slack_Bot SHALL restart the ACP process and log the event

### Requirement 4a: ACP Session Management

**User Story:** As a DevOps engineer, I want each Slack thread to map to a persistent ACP session, so that conversation context is maintained across messages in the same thread and survives process restarts.

#### Acceptance Criteria

1. THE Slack_Bot SHALL map each Slack thread to exactly one ACP session using `session_key = channel_id + ":" + root_thread_ts`
2. WHEN a message arrives for a thread without an existing ACP session, THE Slack_Bot SHALL create a new session via `session/new` and persist the mapping to DynamoDB_Session_Store
3. WHEN a message arrives for a thread with an existing ACP session, THE Slack_Bot SHALL reuse the existing session via `session/prompt`
4. THE Slack_Bot SHALL maintain an in-memory Map as the primary lookup for active sessions to avoid unnecessary DynamoDB reads on every Slack message
5. THE Slack_Bot SHALL use DynamoDB_Session_Store as the persistence layer, read only when the in-memory cache has no entry for a session_key (e.g., after process restart or ACP crash recovery)
6. THE Slack_Bot SHALL persist the following durable fields to DynamoDB_Session_Store: acp_session_id, agent_name, created_at, last_active_at, and ttl
7. THE Slack_Bot SHALL update `last_active_at` and `ttl` in DynamoDB_Session_Store on each `session/prompt`
8. THE DynamoDB_Session_Store SHALL use a TTL of 90 days from last activity for automatic cleanup of stale records
9. THE Slack_Bot SHALL maintain ephemeral runtime state (inflight, queue, statusMessageTs, responseMode) in-memory only — these fields reset on process restart

### Requirement 4a-1: Session Recovery on Restart

**User Story:** As a system operator, I want ACP sessions recovered after a process restart or crash, so that ongoing Slack threads can resume without losing context.

#### Acceptance Criteria

1. WHEN the Slack_Bot restarts and receives a message for a thread with no in-memory session, THE Slack_Bot SHALL look up the session_key in DynamoDB_Session_Store
2. IF a DynamoDB record exists, THE Slack_Bot SHALL attempt to restore the ACP session via `session/load` using the stored acp_session_id
3. IF `session/load` succeeds, THE Slack_Bot SHALL populate the in-memory cache and continue processing
4. IF `session/load` fails (e.g., format incompatibility, missing session files, kiro-cli version upgrade), THE Slack_Bot SHALL gracefully fall back to `session/new`, update DynamoDB_Session_Store with the new acp_session_id, and log the recovery event
5. THE Slack_Bot SHALL NOT expose session recovery failures to the Slack user — the worst case is loss of previous conversation context and a fresh thread start

### Requirement 4b: Session Concurrency Control

**User Story:** As a system operator, I want per-session sequential execution with controlled concurrency, so that the system remains stable and predictable under load.

#### Acceptance Criteria

1. EACH ACP session SHALL process requests sequentially with no concurrent in-flight prompts per session
2. WHEN a request arrives for a session that is currently processing (inflight = true), THE Slack_Bot SHALL enqueue the request in a FIFO queue
3. WHEN a TurnEnd notification is received for a session, THE Slack_Bot SHALL dequeue and process the next request if the queue is non-empty
4. THE Slack_Bot SHALL support a configurable maximum number of concurrent active sessions (default: 2-4)
5. THE Slack_Bot SHALL enforce the Session_Lock at the application layer, not relying on ACP runtime for concurrency control

### Requirement 5: Incident Triage and Investigation

**User Story:** As an on-call engineer, I want the AI agent to perform triage and investigation of incidents, so that I can quickly understand the severity, scope, and potential root causes.

#### Acceptance Criteria

1. WHEN the Senior_Agent receives a request, THE Senior_Agent SHALL analyze the message content to determine incident type
2. THE Senior_Agent SHALL classify incidents as: alert, investigation, validation, or general_query
3. THE Senior_Agent SHALL query relevant logs through Logs_MCP and relevant metrics through Grafana_MCP
4. THE Senior_Agent SHALL generate hypotheses about the incident cause
5. IF the issue is complex and requires deeper analysis, THEN THE Senior_Agent SHALL be available for escalation to Architect_Agent (triggered by human request only)
6. THE Senior_Agent SHALL record the triage decision in the Audit_Log

### Requirement 6: Architect Escalation via Agent Switching

**User Story:** As a DevOps architect, I want to explicitly escalate complex issues to the Architect agent within the same ACP session, so that deeper analysis can be performed without losing conversation context.

#### Acceptance Criteria

1. WHEN a human user sends an escalation command (e.g., `@devops-ai-agent escalate` or `@devops-ai-agent architect`), THE Slack_Bot SHALL trigger agent switching within the same ACP session
2. THE Slack_Bot SHALL switch the active agent using `session/set_mode` to Architect_Agent as the preferred method
3. IF `session/set_mode` is unavailable, THEN THE Slack_Bot SHALL fall back to `_kiro.dev/commands/execute` with `/agent swap architect-agent`
4. THE agent switch SHALL occur within the same ACP session without creating a new session
5. IF the session is currently busy (inflight = true), THEN THE escalation request SHALL be enqueued in the session's FIFO queue
6. THE Architect_Agent SHALL query logs through Logs_MCP with expanded time windows
7. THE Architect_Agent SHALL query metrics through Grafana_MCP with additional context
8. WHERE remediation validation is needed, THE Architect_Agent SHALL trigger GitHub Actions through GitHub_MCP
9. THE Slack_Bot SHALL NOT automatically escalate to Architect_Agent; escalation MUST be explicitly triggered by a human user

### Requirement 7: Secure Log Access

**User Story:** As a security engineer, I want all log access to go through MCP servers, so that raw logs are never exposed to external systems.

#### Acceptance Criteria

1. THE Logs_MCP SHALL enforce a service allowlist for queryable log sources
2. THE Logs_MCP SHALL limit query time windows to 30 days maximum
3. WHEN the Logs_MCP receives a query, THE Logs_MCP SHALL redact sensitive data patterns
4. THE Logs_MCP SHALL return summarized results not exceeding 5000 characters
5. THE Logs_MCP SHALL record all queries in the Audit_Log

### Requirement 8: GitHub Actions Integration

**User Story:** As a DevOps engineer, I want the agent to trigger validation tests, so that I can verify fixes before deploying.

#### Acceptance Criteria

1. WHEN the GitHub_MCP receives a trigger request, THE GitHub_MCP SHALL validate the workflow name against an allowlist
2. THE GitHub_MCP SHALL trigger the specified GitHub Actions workflow
3. THE GitHub_MCP SHALL poll for workflow completion with 5-second intervals
4. WHEN the workflow completes, THE GitHub_MCP SHALL return the status and summary
5. IF the workflow exceeds 600 seconds, THEN THE GitHub_MCP SHALL return a timeout status
6. THE GitHub_MCP SHALL record all workflow triggers in the Audit_Log

### Requirement 9: Safe Response Generation

**User Story:** As a security engineer, I want all responses to be safe summaries, so that sensitive data never appears in Slack.

#### Acceptance Criteria

1. WHEN the Senior_Agent generates a final response, THE Senior_Agent SHALL create a Safe_Summary
2. THE Safe_Summary SHALL contain no raw log lines
3. THE Safe_Summary SHALL contain no IP addresses, hostnames, or credentials
4. THE Safe_Summary SHALL not exceed 2000 characters
5. THE Safe_Summary SHALL include findings, hypotheses, and recommended actions

### Requirement 10: Streaming Response Delivery

**User Story:** As a DevOps engineer, I want to see real-time progress of AI investigations in Slack, so that I know the agent is working and can follow along.

#### Acceptance Criteria

1. WHEN the Slack_Bot begins processing a request, THE Slack_Bot SHALL create a Placeholder_Message in the originating Slack thread
2. THE Slack_Bot SHALL buffer incoming `AgentMessageChunk` notifications in a Streaming_Buffer
3. THE Slack_Bot SHALL update the Placeholder_Message with buffered content every 2-5 seconds
4. THE Slack_Bot SHALL NOT send individual `AgentMessageChunk` notifications as separate Slack messages
5. WHEN a `ToolCallUpdate` notification is received, THE Slack_Bot SHALL render it as a user-friendly status message (e.g., "🔍 Checking logs...", "📊 Checking Grafana...")
6. WHEN a `TurnEnd` notification is received, THE Slack_Bot SHALL flush the final content and replace the Placeholder_Message with the complete Safe_Summary
7. THE Slack_Bot SHALL format the summary using Slack markdown
8. IF the Safe_Summary exceeds Slack message limits, THEN THE Slack_Bot SHALL split it into multiple messages
9. WHEN posting fails, THE Slack_Bot SHALL retry up to 3 times with exponential backoff
10. THE Slack_Bot SHALL reuse the Placeholder_Message for updates whenever possible to minimize Slack API calls

### Requirement 11: Error Handling

**User Story:** As a DevOps engineer, I want clear error messages when the agent encounters problems, so that I can understand what went wrong.

#### Acceptance Criteria

1. IF the ACP process fails to start or crashes, THEN THE Slack_Bot SHALL attempt to restart it and return an error message to Slack indicating temporary unavailability
2. IF an MCP_Server is unreachable, THEN THE agent SHALL return an error message indicating which service is unavailable
3. IF a query returns no results, THEN THE agent SHALL return a message indicating no relevant data was found
4. IF GitHub Actions fails to trigger, THEN THE agent SHALL return an error message with the failure reason
5. THE Slack_Bot SHALL never expose stack traces or internal error details in Slack messages

### Requirement 12: Performance and Concurrency Requirements

**User Story:** As a DevOps engineer, I want fast responses to urgent incidents with predictable concurrency behavior, so that I can act quickly during outages.

#### Acceptance Criteria

1. WHEN a simple query is processed, THE system SHALL return a response within 30 seconds
2. WHEN a complex investigation is processed, THE system SHALL return a response within 180 seconds
3. THE Slack_Bot SHALL acknowledge receipt of a message within 6 seconds
4. THE MCP_Server SHALL respond to queries within 20 seconds
5. THE system SHALL support 2-4 concurrent active ACP sessions without degradation
6. EACH ACP session SHALL process one request at a time with additional requests queued in FIFO order
7. THE Slack_Bot SHALL provide streaming progress updates during investigation to maintain user awareness

### Requirement 13: Configuration Management

**User Story:** As a system administrator, I want to configure allowlists and limits without code changes, so that I can adapt to operational needs.

#### Acceptance Criteria

1. THE Slack_Bot SHALL load the Channel_Allowlist from a configuration file at startup
2. THE MCP_Server SHALL load service allowlists from configuration files at startup
3. THE GitHub_MCP SHALL load workflow allowlists from a configuration file at startup
4. WHEN a configuration file changes, THE system SHALL reload the configuration within 60 seconds
5. IF a configuration file is invalid, THEN THE system SHALL log an error and continue with the previous valid configuration

### Requirement 14: Session Logging

**User Story:** As a DevOps engineer, I want successful investigation sessions automatically saved in a consistent format regardless of execution path, so that valuable troubleshooting knowledge can be captured and reused.

#### Acceptance Criteria

1. ALL Session_Logs SHALL be saved to `~/.kiro/logs/` with a filename in the format `[agent_name]-YYYY-MM-DD-HH-MM.md`
2. ALL Session_Logs SHALL use the same markdown format regardless of which execution path produced them, including the original alert or question, investigation steps, findings, and resolution
3. THE system SHALL create the `~/.kiro/logs/` directory if it does not exist
4. FOR ACP modes (auto_investigation, mention_based): WHEN a TurnEnd notification is received, THE Slack_Bot SHALL assemble the session content from accumulated streaming output (AgentMessageChunk, ToolCallUpdate) and write it to `~/.kiro/logs/` in the standard Session_Log format
5. FOR learning mode: THE Slack_Bot SHALL capture the session log from the `kiro-cli chat` stdout output, which is redirected to `~/.kiro/logs/` during the spawn

### Requirement 14a: Slack Routing Modes

**User Story:** As a DevOps team lead, I want different Slack channels to trigger different behaviors (learning, auto-investigation, mention-based), so that the system adapts to each channel's purpose.

#### Acceptance Criteria

1. THE Routing_Layer SHALL support the following modes per channel: learning, auto_investigation, and mention_based
2. WHEN a message arrives in a channel configured as `learning` mode, THE Slack_Bot SHALL spawn a `kiro-cli chat --no-interactive --agent senior-agent` process with stdout redirected to `~/.kiro/logs/` to investigate the message silently, without creating an ACP session or sending a Slack response
3. WHEN a message arrives in a channel configured as `auto_investigation` mode, THE Slack_Bot SHALL automatically create or reuse an ACP session, set agent to Senior_Agent, and begin investigation
4. WHEN a message arrives in a channel configured as `mention_based` mode, THE Slack_Bot SHALL require an `app_mention` event before creating or reusing an ACP session
5. THE channel routing mode SHALL be configurable via the Channel_Allowlist configuration file
6. WHEN an escalation command is detected in any active thread, THE Slack_Bot SHALL load the existing ACP session and switch the agent to Architect_Agent

### Requirement 14b: Response Modes

**User Story:** As a DevOps engineer, I want investigation results delivered either in the originating thread or published to a dedicated channel, so that findings reach the right audience.

#### Acceptance Criteria

1. THE Slack_Bot SHALL support two response modes per session: `thread_reply` and `publish_channel`
2. WHEN response_mode is `thread_reply`, THE Slack_Bot SHALL post the response in the originating Slack thread
3. WHEN response_mode is `publish_channel`, THE Slack_Bot SHALL post the response to a configured dedicated channel with a permalink to the original message as the title
4. THE response_mode SHALL be configurable per channel in the Channel_Allowlist configuration

### Requirement 15: Skill Improvement PR Creation

**User Story:** As a DevOps team lead, I want the system to periodically analyze completed sessions and create pull requests for skill improvements, so that valuable knowledge can be reviewed and integrated.

#### Acceptance Criteria

1. THE system SHALL run a Skill_Analysis_Cronjob on a configurable schedule (default: every 30 minutes)
2. THE Skill_Analysis_Cronjob SHALL scan `~/.kiro/logs/` for Session_Log files without the `-analyzed` suffix, regardless of whether the log was produced by ACP streaming assembly or `kiro-cli chat` stdout redirect
3. THE Skill_Analysis_Cronjob SHALL process each un-analyzed Session_Log sequentially to avoid race conditions
4. FOR each Session_Log, THE Skill_Analysis_Cronjob SHALL analyze the content against existing Custom_Skill files in the skills directory
5. IF the session content semantically matches an existing Custom_Skill, THEN THE cronjob SHALL propose an update to that existing skill
6. IF the session content does not match any existing Custom_Skill, THEN THE cronjob SHALL propose a new skill file
7. THE Skill_Analysis_Cronjob SHALL use gh CLI to create a Skill_Improvement_PR with the proposed skill changes
8. WHEN analysis and PR creation are complete for a Session_Log, THE cronjob SHALL rename the file by appending `-analyzed` to the filename (e.g., `senior-engineer-2026-03-15-14-30-analyzed.md`)
9. THE Skill_Improvement_PR description SHALL include a summary of the session findings and the file path to the Session_Log
10. THE Skill_Improvement_PR SHALL target a designated skills repository or branch
11. THE Skill_Improvement_PR SHALL include metadata: session timestamp, incident type, affected systems, and whether the PR creates a new skill or updates an existing one
12. THE Skill_Analysis_Cronjob SHALL log execution status and errors to the CloudWatch_LogGroup

### Requirement 16: Human Review Workflow

**User Story:** As a senior engineer, I want to review proposed skill improvements before they are applied, so that quality and accuracy are maintained.

#### Acceptance Criteria

1. WHEN a Skill_Improvement_PR is created, THE system SHALL notify designated reviewers via GitHub
2. THE Skill_Improvement_PR SHALL remain in draft or review-required state until approved
3. THE system SHALL support review comments and requested changes on the PR
4. WHEN a reviewer approves the PR, THE system SHALL allow the PR to be merged
5. THE system SHALL prevent auto-merging of Skill_Improvement_PRs without human approval

### Requirement 17: Automatic Skill Integration

**User Story:** As a DevOps engineer, I want approved skill improvements automatically integrated, so that the agent continuously learns from successful investigations.

#### Acceptance Criteria

1. WHEN a Skill_Improvement_PR is merged, THE Kiro_CLI_ACP SHALL detect the merge event
2. THE Kiro_CLI_ACP SHALL extract the skill updates from the merged PR content
3. THE Kiro_CLI_ACP SHALL update the relevant Custom_Skill files in the skills directory
4. THE Kiro_CLI_ACP SHALL validate the updated skill syntax before applying
5. IF skill validation fails, THEN THE Kiro_CLI_ACP SHALL log an error and revert to the previous skill version

### Requirement 18: Skill Repository Management

**User Story:** As a system administrator, I want custom skills stored in a version-controlled repository, so that changes are tracked and can be rolled back if needed.

#### Acceptance Criteria

1. THE system SHALL maintain Custom_Skill files in a designated Git repository
2. THE Custom_Skill files SHALL be stored in markdown format in the skills directory
3. WHEN a Custom_Skill is updated, THE system SHALL commit the change with a descriptive message
4. THE system SHALL maintain a changelog of skill modifications
5. THE system SHALL support rollback to previous skill versions via Git history

### Requirement 19: Session Metric Collection

**User Story:** As a DevOps team lead, I want session metrics automatically extracted from logs and PR outcomes, so that skill effectiveness can be measured without manual input.

#### Acceptance Criteria

1. THE Skill_Analysis_Cronjob SHALL extract a Session_Metric from each Session_Log during analysis, including: incident_type, skills_referenced, resolution_time_seconds, escalation_needed, and agent_name
2. THE incident_type SHALL be parsed from the original alert or question in the Session_Log content
3. THE skills_referenced SHALL be identified by scanning the Session_Log for Custom_Skill file references
4. THE resolution_time_seconds SHALL be calculated from the Session_Log file creation timestamp to the file last-modified timestamp
5. THE escalation_needed field SHALL be determined by detecting delegation patterns in the Session_Log (e.g., Senior_Agent escalating to Architect_Agent)
6. THE human_rating field SHALL be derived from the associated Skill_Improvement_PR status: merged = useful, closed without merge = not_useful, open longer than 7 days = skip
7. THE Benchmark_Cronjob SHALL query GitHub PR statuses via gh CLI to update human_rating values for previously collected Session_Metrics
8. THE Session_Metric SHALL be stored in a structured format (JSON) in a configurable metrics directory
9. THE Session_Metric SHALL include a timestamp and session identifier

### Requirement 20: Periodic Skill Benchmarking via Cronjob

**User Story:** As a DevOps team lead, I want skill effectiveness benchmarked on a schedule, so that I can track improvement trends without impacting agent response times.

#### Acceptance Criteria

1. THE system SHALL run a Benchmark_Cronjob on a configurable schedule (default: weekly)
2. THE Benchmark_Cronjob SHALL aggregate Session_Metrics per Custom_Skill for the current week
3. THE Benchmark_Cronjob SHALL produce a Skill_Benchmark_Report containing per-skill: times_referenced, average_resolution_time, escalation_rate, and human_approval_rate
4. THE Benchmark_Cronjob SHALL compare current week metrics against the previous week to detect regressions
5. IF a skill's escalation_rate increases or average_resolution_time increases by more than 20% compared to the previous week, THEN THE Benchmark_Cronjob SHALL flag the skill as regressed
6. THE Skill_Benchmark_Report SHALL be saved to a configurable output directory in markdown format

### Requirement 21: Benchmark Reporting and Alerting

**User Story:** As a DevOps team lead, I want to be notified when skill performance degrades, so that I can take corrective action.

#### Acceptance Criteria

1. WHEN the Benchmark_Cronjob detects a regressed skill, THE system SHALL send a notification to a configurable Slack channel
2. THE notification SHALL include the skill name, regression metrics, and a link to the Skill_Benchmark_Report
3. THE Skill_Benchmark_Report SHALL be queryable by skill name, incident type, and time range
4. THE system SHALL retain Skill_Benchmark_Reports for 90 days minimum
5. THE Benchmark_Cronjob SHALL log execution status and errors to the CloudWatch_LogGroup

### Requirement 22: Tool Permission Whitelist

**User Story:** As a security engineer, I want the bot to enforce a tool whitelist when approving ACP permission requests, so that agents cannot execute unauthorized tools.

#### Acceptance Criteria

1. THE Slack_Bot SHALL maintain a configurable tool whitelist per agent (with a global fallback)
2. WHEN `session/request_permission` is received from ACP, THE Slack_Bot SHALL check the requested tool name against the whitelist
3. IF the tool is on the whitelist, THEN THE Slack_Bot SHALL respond with `optionId: "allow_once"`
4. IF the tool is NOT on the whitelist, THEN THE Slack_Bot SHALL respond with `optionId: "deny"`
5. WHEN a tool request is denied, THE Slack_Bot SHALL log the denial at WARN level with tool name and session context
6. IF the whitelist is empty or not configured, THEN THE Slack_Bot SHALL approve all tools (backward compatible)
7. THE tool whitelist SHALL be configurable via `app.json` or per-agent configuration
