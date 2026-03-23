import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { AgentName, ResponseMode, SessionRecord, SessionState } from '../types';

export interface SessionStore {
  get(sessionKey: string): Promise<SessionState | null>;
  put(state: SessionState): Promise<void>;
  touch(sessionKey: string, updates: Partial<SessionState>): Promise<SessionState | null>;
}

export interface SessionStoreOptions {
  tableName?: string;
  ttlSeconds?: number;
  client?: Pick<DynamoDBClient, 'send'>;
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

function nowIso(): string {
  return new Date().toISOString();
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toAgentName(value: string | undefined): AgentName {
  return value === 'architect-agent' ? 'architect-agent' : 'senior-agent';
}

function toResponseMode(value: string | undefined): ResponseMode {
  return value === 'publish_channel' ? 'publish_channel' : 'thread_reply';
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  async get(sessionKey: string): Promise<SessionState | null> {
    return this.sessions.get(sessionKey) ?? null;
  }

  async put(state: SessionState): Promise<void> {
    this.sessions.set(state.sessionKey, { ...state, queue: [...state.queue] });
  }

  async touch(sessionKey: string, updates: Partial<SessionState>): Promise<SessionState | null> {
    const current = this.sessions.get(sessionKey);
    if (!current) {
      return null;
    }

    const next: SessionState = {
      ...current,
      ...updates,
      queue: updates.queue ? [...updates.queue] : [...current.queue],
      lastUpdatedAt: updates.lastUpdatedAt ?? nowIso(),
    };

    this.sessions.set(sessionKey, next);
    return next;
  }
}

export class DynamoDbSessionStore implements SessionStore {
  private readonly client: Pick<DynamoDBClient, 'send'>;
  private readonly ttlSeconds: number;

  constructor(private readonly options: Required<SessionStoreOptions>) {
    this.client = options.client;
    this.ttlSeconds = options.ttlSeconds;
  }

  async get(sessionKey: string): Promise<SessionState | null> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.options.tableName,
        Key: { pk: { S: sessionKey } },
      })
    );

    if (!result.Item) {
      return null;
    }

    return {
      sessionKey: result.Item.pk.S ?? sessionKey,
      acpSessionId: result.Item.acpSessionId.S ?? '',
      activeAgent: toAgentName(result.Item.agentName.S),
      inflight: result.Item.inflight?.BOOL ?? false,
      queue: [],
      responseMode: toResponseMode(result.Item.responseMode?.S),
      statusMessageTs: result.Item.statusMessageTs?.S,
      lastUpdatedAt: result.Item.lastUpdatedAt?.S ?? nowIso(),
    };
  }

  async put(state: SessionState): Promise<void> {
    const record: SessionRecord = {
      pk: state.sessionKey,
      acpSessionId: state.acpSessionId,
      agentName: state.activeAgent,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      ttl: nowEpochSeconds() + this.ttlSeconds,
    };

    await this.client.send(
      new PutItemCommand({
        TableName: this.options.tableName,
        Item: {
          pk: { S: record.pk },
          acpSessionId: { S: record.acpSessionId },
          agentName: { S: record.agentName },
          responseMode: { S: state.responseMode },
          inflight: { BOOL: state.inflight },
          statusMessageTs: state.statusMessageTs ? { S: state.statusMessageTs } : { NULL: true },
          lastUpdatedAt: { S: state.lastUpdatedAt },
          createdAt: { N: String(record.createdAt) },
          lastActiveAt: { N: String(record.lastActiveAt) },
          ttl: { N: String(record.ttl) },
        },
      })
    );
  }

  async touch(sessionKey: string, updates: Partial<SessionState>): Promise<SessionState | null> {
    const current = await this.get(sessionKey);
    if (!current) {
      return null;
    }

    const next: SessionState = {
      ...current,
      ...updates,
      queue: updates.queue ? [...updates.queue] : current.queue,
      lastUpdatedAt: updates.lastUpdatedAt ?? nowIso(),
    };

    await this.put(next);
    return next;
  }
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  if (options.tableName) {
    return new DynamoDbSessionStore({
      tableName: options.tableName,
      ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      client: options.client ?? new DynamoDBClient({}),
    });
  }

  return new InMemorySessionStore();
}
