import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import type { AgentName, ResponseMode, SessionRecord, SessionState } from '../types';
import { createLogger } from '../logging/logger';

const log = createLogger('session-store');

export interface SessionStore {
  get(sessionKey: string): Promise<SessionState | null>;
  getByAcpSessionId(acpSessionId: string): Promise<SessionState | null>;
  put(state: SessionState): Promise<void>;
  touch(sessionKey: string, updates: Partial<SessionState>): Promise<SessionState | null>;
}

export interface SessionStoreOptions {
  tableName?: string;
  ttlSeconds?: number;
  client?: Pick<DynamoDBClient, 'send'>;
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
const ACP_SESSION_ID_INDEX_NAME = 'acpSessionId-index';

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

function fromItem(sessionKey: string, item: Record<string, any>): SessionState {
  return {
    sessionKey: item.pk?.S ?? sessionKey,
    acpSessionId: item.acpSessionId?.S ?? '',
    activeAgent: toAgentName(item.agentName?.S),
    inflight: item.inflight?.BOOL ?? false,
    queue: item.queue?.S ? (JSON.parse(item.queue.S) as SessionState['queue']) : [],
    responseMode: toResponseMode(item.responseMode?.S),
    statusMessageTs: item.statusMessageTs?.S,
    sessionNotice: item.sessionNotice?.S,
    lastUpdatedAt: item.lastUpdatedAt?.S ?? nowIso(),
  };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  async get(sessionKey: string): Promise<SessionState | null> {
    return this.sessions.get(sessionKey) ?? null;
  }

  async getByAcpSessionId(acpSessionId: string): Promise<SessionState | null> {
    for (const state of this.sessions.values()) {
      if (state.acpSessionId === acpSessionId) {
        return state;
      }
    }
    return null;
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

    return fromItem(sessionKey, result.Item as Record<string, any>);
  }

  async getByAcpSessionId(acpSessionId: string): Promise<SessionState | null> {
    log.debug('getByAcpSessionId:start', { acpSessionId });

    const result = await this.client.send(
      new QueryCommand({
        TableName: this.options.tableName,
        IndexName: ACP_SESSION_ID_INDEX_NAME,
        KeyConditionExpression: 'acpSessionId = :acpSessionId',
        ExpressionAttributeValues: {
          ':acpSessionId': { S: acpSessionId },
        },
        Limit: 1,
      })
    );

    const item = result.Items?.[0];
    if (!item) {
      log.debug('getByAcpSessionId:miss', { acpSessionId });
      return null;
    }

    log.debug('getByAcpSessionId:hit', { acpSessionId, sessionKey: item.pk?.S ?? '' });
    return fromItem(item.pk?.S ?? '', item as Record<string, any>);
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
          ...(record.acpSessionId ? { acpSessionId: { S: record.acpSessionId } } : {}),
          agentName: { S: record.agentName },
          responseMode: { S: state.responseMode },
          inflight: { BOOL: state.inflight },
          queue: { S: JSON.stringify(state.queue) },
          statusMessageTs: state.statusMessageTs ? { S: state.statusMessageTs } : { NULL: true },
          ...(state.sessionNotice ? { sessionNotice: { S: state.sessionNotice } } : {}),
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
