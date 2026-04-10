# Documentation Index

> **For AI assistants:** This file is the primary entry point for understanding the ChatOps AI Agent codebase. Read this file first to determine which detailed documentation files to consult for specific questions.

## How to Use This Documentation

1. **Start here** — This index contains summaries of every documentation file. Most questions can be answered by reading the relevant summary below and then consulting the detailed file only if needed.
2. **Architecture questions** → `architecture.md`
3. **"Where does X happen?"** → `components.md` (find the responsible component) → then read the source file
4. **API/protocol questions** → `interfaces.md`
5. **Data structure questions** → `data_models.md`
6. **"How does X work end-to-end?"** → `workflows.md`
7. **Dependency/infra questions** → `dependencies.md`
8. **Known gaps** → `review_notes.md`

## File Summaries

### [codebase_info.md](codebase_info.md)
<!-- tags: overview, stack, layout, config -->
Project metadata, technology stack, repository directory layout, and the three-layer configuration strategy. Consult when you need to understand the project structure, what technologies are used, or how configuration is organized.

### [architecture.md](architecture.md)
<!-- tags: architecture, design, patterns, flow -->
System-level architecture diagram showing the full message flow from Slack through the Node.js process to ACP and back. Documents key design patterns: per-thread session mapping, FIFO queue with inflight lock, promise-chain locking, streaming updates, agent switching, and transport recycling. Consult for "why is it designed this way?" questions.

### [components.md](components.md)
<!-- tags: components, classes, responsibilities -->
Detailed description of every major component: `SlackSessionRuntime`, `AcpProcessManager` (+ `JsonRpcAcpTransport`), `SlackStreamController`, `RoutingLayer`, `ConfigurationManager`, `SessionStore`, `CloudWatchLogger`, and supporting modules. Consult when you need to understand what a specific class/module does and its responsibilities.

### [interfaces.md](interfaces.md)
<!-- tags: api, protocol, jsonrpc, commands, modes -->
All internal TypeScript interfaces (`SessionStore`, `AcpTransport`, `SlackClientLike`), the ACP JSON-RPC protocol surface (requests and notifications), Slack bot commands and their routing actions, channel modes, and response modes. Consult for API contracts and protocol details.

### [data_models.md](data_models.md)
<!-- tags: types, schema, dynamodb, config -->
Complete type definitions for all core data structures (`ChannelConfig`, `SlackEvent`, `SessionState`, `SessionRequest`, `AcpEvent`, `AcpPromptPayload`), the DynamoDB table schema with GSI, and the `AppConfig` structure with env var override mappings. Consult for "what fields does X have?" questions.

### [workflows.md](workflows.md)
<!-- tags: workflows, sequences, lifecycle, startup -->
End-to-end sequence diagrams for: message processing, agent escalation, session recovery (with load fallback), application startup, and channel config hot-reload. Consult for "what happens when...?" questions.

### [dependencies.md](dependencies.md)
<!-- tags: dependencies, aws, terraform, mcp -->
Runtime and dev dependencies with versions and purposes, external service integrations (Slack, DynamoDB, CloudWatch, kiro-cli ACP), Terraform infrastructure resources, and MCP server configuration. Consult for dependency and infrastructure questions.

### [review_notes.md](review_notes.md)
<!-- tags: gaps, review, recommendations -->
Documentation consistency and completeness review. Lists well-documented areas, identified gaps (unused `node-cron`, aspirational types, undocumented `status` handler), and recommendations. Consult when investigating potential issues or planning improvements.
