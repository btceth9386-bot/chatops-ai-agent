# Review Notes

## Consistency Check

No inconsistencies found across documentation files. Type names, interface signatures, and architectural descriptions are aligned with the source code.

## Completeness Check

### Well-Documented Areas
- ACP JSON-RPC protocol surface (initialize, session/new, session/load, session/prompt, session/set_mode)
- Session lifecycle (create, load, recover, queue, inflight lock)
- Streaming update pipeline (delta buffering, throttled flush, final completion)
- DynamoDB schema and GSI design
- Configuration layers and env var overrides
- Agent switching mechanics

### Gaps Identified

1. **Phase 2/3 not started** — The specs define skill analysis cronjobs, benchmark cronjobs, session log assembly on TurnEnd, and tool permission whitelists. None of these have runtime code yet, though types exist in `src/types/index.ts`.

2. **`session/request_permission` auto-approves everything** — The current code approves all tool permission requests unconditionally. Requirement 22 specifies a configurable per-agent tool whitelist with deny capability. This is a Phase 2 task (task 11.5).

3. **Session log assembly on TurnEnd** — Requirement 14.4 specifies that ACP modes should assemble session content from streaming output on TurnEnd and write it to `~/.kiro/logs/`. This is not implemented.

4. **ToolCallUpdate → user-friendly status messages** — Requirement 10.5 specifies rendering tool calls as status messages (e.g., "🔍 Checking logs..."). The current code logs `tool_call` events but does not render them in Slack.

5. **Slack API retry with backoff** — Requirement 10.9 specifies retry up to 3 times with exponential backoff for Slack post failures. Not implemented.

6. **Design ↔ implementation file name divergence** — The design doc uses different file names than the actual implementation. This is now documented in AGENTS.md.

7. **`node-cron` usage** — Listed as a dependency but no active cron job was found in the core source files. It is intended for Phase 2/3 cronjobs.

8. **`status` command handler** — The routing layer detects `status` commands, but the response format is not documented.

9. **`publish_channel` response mode** — Currently streams directly to the publish target without a final summarized post or backlink formatting.

## Recommendations

- Implement tool permission whitelist (Req 22 / task 11.5) before production use — current auto-approve-all is a security gap
- Implement session log assembly on TurnEnd (Req 14.4) to enable the Phase 2 skill analysis pipeline
- Add Slack API retry with exponential backoff (Req 10.9) for production resilience
- Document the `status` command response format
- Clarify `node-cron` is reserved for Phase 2/3 cronjobs
