import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, DynamoDbSessionStore, InMemorySessionStore } from '../../src/sessions/store';
import type { SessionState } from '../../src/types';

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionKey: 'THREAD#C1:1.2',
    acpSessionId: 'acp-1',
    activeAgent: 'senior-agent',
    inflight: false,
    queue: [],
    responseMode: 'thread_reply',
    lastUpdatedAt: '2026-03-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('session store', () => {
  it('uses in-memory store when dynamodb table is not configured', () => {
    const store = createSessionStore();
    expect(store).toBeInstanceOf(InMemorySessionStore);
  });

  it('stores and updates state in memory', async () => {
    const store = new InMemorySessionStore();
    const state = makeState();

    await store.put(state);
    await store.touch(state.sessionKey, { inflight: true });

    await expect(store.get(state.sessionKey)).resolves.toMatchObject({ inflight: true, acpSessionId: 'acp-1' });
  });

  it('reads and writes dynamodb session records', async () => {
    const queue = [{
      messageText: 'hello',
      channelId: 'C1',
      threadTs: '1.2',
      userId: 'U1',
      timestamp: '1.2',
      kind: 'prompt' as const,
    }];

    const item = {
      pk: { S: 'THREAD#C1:1.2' },
      acpSessionId: { S: 'acp-1' },
      agentName: { S: 'architect-agent' },
      responseMode: { S: 'publish_channel' },
      inflight: { BOOL: true },
      queue: { S: JSON.stringify(queue) },
      statusMessageTs: { S: '999.1' },
      lastUpdatedAt: { S: '2026-03-23T00:00:00.000Z' },
    };

    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: item })
      .mockResolvedValueOnce({ Items: [item] });

    const store = new DynamoDbSessionStore({ tableName: 'sessions', ttlSeconds: 123, client: { send } as any });
    await store.put(makeState({ queue }));
    const loaded = await store.get('THREAD#C1:1.2');
    const loadedByAcp = await store.getByAcpSessionId('acp-1');

    expect(send).toHaveBeenCalled();
    expect(loaded).toMatchObject({
      activeAgent: 'architect-agent',
      responseMode: 'publish_channel',
      inflight: true,
      queue,
    });
    expect(loadedByAcp).toMatchObject({ sessionKey: 'THREAD#C1:1.2', acpSessionId: 'acp-1' });
  });
});
