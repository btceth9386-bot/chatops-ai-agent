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

1. **`app.ts` bootstrap details** — The `loadMcpServers` and `loadSkills` functions are documented at a high level but their exact behavior (file paths read, error handling) was not deeply traced. These are straightforward file-read operations.

2. **`node-cron` usage** — Listed as a dependency but no active cron job was found in the core source files analyzed. It may be used in a future phase or in code not yet committed.

3. **`status` command handler** — The routing layer detects `status` commands, but the actual handler that formats and sends the status response was not traced in detail. It likely lives in `session-runtime.ts` or `events.ts`.

4. **`publish_channel` response mode** — Documented as a response mode, but the README notes it currently streams directly to the publish target without a final summarized post or backlink formatting.

5. **Future/aspirational types** — `src/types/index.ts` contains several interfaces (`SafeSummary`, `TriageResult`, `ToolUpdate`, `SessionMetric`, `SkillBenchmark`, `BenchmarkReport`, `BenchmarkConfig`, `SkillAnalysisConfig`, `SkillAnalysisResult`) that appear to be forward-looking types for planned features not yet implemented in the current codebase.

6. **Terraform variables** — `terraform/variables.tf` and `terraform/outputs.tf` were not read in detail. The resources themselves are fully documented.

7. **Error recovery edge cases** — The transport recycling and stale-inflight recovery paths are documented, but the exact behavior when DynamoDB is unreachable is not explicitly covered (the app would throw and the error would propagate to Slack as a failure message).

## Recommendations

- Consider removing or marking aspirational types in `src/types/index.ts` to reduce confusion
- Document the `status` command response format
- Clarify `node-cron` usage or remove the dependency if unused
- Add explicit error handling documentation for AWS service outages
