export type ChannelMode = 'learning' | 'auto_investigation' | 'mention_based';
export type ResponseMode = 'thread_reply' | 'publish_channel';
export type AgentName = 'senior-agent' | 'architect-agent';

export interface ChannelConfig {
  channelId: string;
  mode: ChannelMode;
  responseMode: ResponseMode;
  publishChannelId?: string;
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
  maxActiveSessions: number;
  configFilePath: string;
}

export interface SlackEvent {
  type: 'app_mention' | 'message';
  messageText: string;
  channelId: string;
  threadTs: string;
  userId: string;
  timestamp: string;
}

export interface SanitizedInput {
  text: string;
  wasTruncated: boolean;
  originalLength: number;
}

export interface SessionRecord {
  pk: string;
  acpSessionId: string;
  agentName: AgentName;
  createdAt: number;
  lastActiveAt: number;
  ttl: number;
}

export interface SessionRequest {
  messageText: string;
  channelId: string;
  threadTs: string;
  userId: string;
  timestamp: string;
  kind?: 'prompt' | 'escalation';
}

export interface SessionState {
  sessionKey: string;
  acpSessionId: string;
  activeAgent: AgentName;
  inflight: boolean;
  queue: SessionRequest[];
  responseMode: ResponseMode;
  statusMessageTs?: string;
  lastUpdatedAt: string;
}

export interface SafeSummary {
  findings: string;
  hypotheses: string[];
  recommendedActions: string[];
  totalLength: number;
}

export interface TriageResult {
  incidentType: 'alert' | 'investigation' | 'validation' | 'general_query';
  severity: string;
  reasoning: string;
}

export interface ToolUpdate {
  toolName: string;
  status: 'started' | 'completed' | 'failed';
  summary?: string;
}

export interface AgentConfig {
  name: AgentName;
  role: string;
  tools: string[];
  skills: string[];
}

export interface AuditLogEntry {
  timestamp: string;
  requesterId: string;
  channelId: string;
  threadTs: string;
  action: string;
  component: string;
  details: Record<string, unknown>;
  queryId: string;
}

export interface ErrorLogEntry {
  timestamp: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  stackTrace?: string;
  requestContext?: {
    channelId?: string;
    threadTs?: string;
    userId?: string;
    component?: string;
    [key: string]: unknown;
  };
}

export interface SessionMetric {
  sessionId: string;
  timestamp: string;
  agentName: AgentName;
  incidentType: string;
  skillsReferenced: string[];
  resolutionTimeSeconds: number;
  escalationNeeded: boolean;
  humanRating: 'useful' | 'not_useful' | 'skip' | 'pending';
  prNumber: number | null;
}

export interface SkillBenchmark {
  skillName: string;
  timesReferenced: number;
  averageResolutionTime: number;
  escalationRate: number;
  humanApprovalRate: number;
}

export interface BenchmarkReport {
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

export interface BenchmarkConfig {
  schedule: string;
  metricsDirectory: string;
  outputDirectory: string;
  regressionThreshold: number;
  retentionDays: number;
  alertSlackChannel: string;
  cloudwatchLogGroup: string;
}

export interface SkillAnalysisConfig {
  scheduleInterval: string;
  logsDirectory: string;
  skillsDirectory: string;
  targetRepo: string;
  targetBranch: string;
  cloudwatchLogGroup: string;
}

export interface SkillAnalysisResult {
  sessionLogPath: string;
  matchedSkill: string | null;
  prNumber: number;
  prUrl: string;
  action: 'create' | 'update';
  metadata: {
    sessionTimestamp: string;
    incidentType: string;
    affectedSystems: string[];
  };
}

export interface AcpPromptPayload {
  sessionId: string;
  prompt: Array<{
    type: 'text';
    text: string;
  }>;
  agent: AgentName;
  metadata: {
    channelId: string;
    threadTs: string;
    userId: string;
    requestKind: 'prompt' | 'escalation';
  };
}

export interface AcpEvent {
  sessionId: string;
  type: 'started' | 'delta' | 'final' | 'error';
  text?: string;
  error?: string;
}
