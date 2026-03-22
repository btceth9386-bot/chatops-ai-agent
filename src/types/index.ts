export type ChannelMode = 'learning' | 'auto_investigation' | 'mention_based';
export type ResponseMode = 'thread_reply' | 'publish_channel';

export interface ChannelConfig {
  channelId: string;
  mode: ChannelMode;
  responseMode?: ResponseMode;
  enabled?: boolean;
}

export interface SlackBotConfig {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  channelAllowlist: ChannelConfig[];
  cloudwatchLogGroup: string;
  dynamoTableName: string;
  maxMessageLength: number;
  configReloadIntervalMs?: number;
}

export interface SlackEvent {
  type: 'app_mention' | 'message';
  channelId: string;
  threadTs: string;
  userId: string;
  text: string;
  ts?: string;
}

export interface SanitizedInput {
  text: string;
  wasTruncated: boolean;
  originalLength: number;
}

export type AgentName = 'senior-agent' | 'architect-agent';

export interface SessionRecord {
  sessionKey: string;
  acpSessionId: string;
  agentName: AgentName;
  createdAt: string;
  lastActiveAt: string;
  ttl: number;
}

export interface SessionRequest {
  requestId: string;
  message: string;
  userId: string;
  createdAt: number;
  kind?: 'prompt' | 'escalation';
}

export interface SessionState {
  record: SessionRecord;
  inflight: boolean;
  queue: SessionRequest[];
  statusMessageTs?: string;
  responseMode?: ResponseMode;
}

export interface SafeSummary {
  findings: string[];
  hypotheses: string[];
  recommendedActions: string[];
  finalText: string;
}

export interface TriageResult {
  incidentType: 'alert' | 'investigation' | 'validation' | 'general_query';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  rationale: string;
}

export interface ToolUpdate {
  toolName: string;
  status: 'started' | 'running' | 'done' | 'failed';
  message?: string;
  timestamp: string;
}

export interface AgentConfig {
  name: AgentName;
  model?: string;
  temperature?: number;
}

export interface AuditLogEntry {
  timestamp: string;
  sessionKey?: string;
  userId?: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface ErrorLogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  stackTrace?: string;
  requestContext?: Record<string, unknown>;
}

export interface SessionMetric {
  sessionKey: string;
  incidentType: string;
  skillsReferenced: string[];
  resolutionTimeSeconds?: number;
  escalationNeeded: boolean;
  agentName: AgentName;
  timestamp: string;
}

export interface SkillBenchmark {
  skillName: string;
  runs: number;
  successRate: number;
  avgResolutionTimeSeconds: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  benchmarks: SkillBenchmark[];
}

export interface BenchmarkConfig {
  cron: string;
  alertThresholdPct: number;
}

export interface SkillAnalysisConfig {
  skillsDir: string;
  logsDir: string;
  maxFilesPerRun?: number;
}

export interface SkillAnalysisResult {
  analyzedFile: string;
  matchedSkill?: string;
  action: 'update_existing' | 'create_new' | 'no_change';
  summary: string;
}
