import { describe, expect, it, vi } from 'vitest';
import { SlackSessionRuntime } from '../../src/slack-bot/session-runtime';
import { InMemorySessionStore } from '../../src/sessions/store';
import type { AcpEvent, AcpPromptPayload, SlackEvent } from '../../src/types';

class FakeAcpManager {
  private readonly listeners = new Set<(event: AcpEvent) => void>();
  public readonly prompts: AcpPromptPayload[] = [];
  private readonly sessions = new Map<string, string>();
  private sessionCounter = 0;

  onEvent(listener: (event: AcpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  hasSession(sessionKey: string, expectedSessionId?: string): boolean {
    const current = this.sessions.get(sessionKey);
    if (!current) {
      return false;
    }

    return expectedSessionId ? current === expectedSessionId : true;
  }

  async ensureSession(sessionKey: string, existingSessionId?: string): Promise<{ sessionId: string; resumed: boolean; fallbackFromLoad: boolean }> {
    const sessionId = existingSessionId ?? this.sessions.get(sessionKey) ?? `acp-${++this.sessionCounter}`;
    const resumed = Boolean(existingSessionId || this.sessions.get(sessionKey));
    this.sessions.set(sessionKey, sessionId);
    return {
      sessionId,
      resumed,
      fallbackFromLoad: false,
    };
  }

  async sendPrompt(payload: AcpPromptPayload): Promise<void> {
    this.prompts.push(payload);
  }

  emit(event: AcpEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeStreamController {
  public readonly placeholders: string[] = [];
  public readonly updates: string[] = [];
  public readonly failures: string[] = [];

  async ensurePlaceholder(): Promise<string> {
    const ts = `placeholder-${this.placeholders.length + 1}`;
    this.placeholders.push(ts);
    return ts;
  }

  async pushDelta(_target: unknown, _statusMessageTs: string, text: string): Promise<void> {
    this.updates.push(text);
  }

  async complete(_target: unknown, _statusMessageTs: string, text: string): Promise<void> {
    this.updates.push(`FINAL:${text}`);
  }

  async fail(_target: unknown, _statusMessageTs: string, error: string): Promise<void> {
    this.failures.push(error);
  }
}

const logger = {
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
} as any;

function event(messageText: string): SlackEvent {
  return {
    type: 'message',
    messageText,
    channelId: 'C1',
    threadTs: '123.456',
    userId: 'U1',
    timestamp: '123.456',
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SlackSessionRuntime', () => {
  it('queues prompt then escalation in the same session and preserves ACP session id', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('first prompt'), channel, 'prompt');
    await runtime.enqueue(event('architect please help'), channel, 'escalation');

    expect(acpManager.prompts).toHaveLength(1);
    expect(acpManager.prompts[0]).toMatchObject({
      agent: 'senior-agent',
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'first prompt' }],
    });
    expect('content' in acpManager.prompts[0]).toBe(false);

    acpManager.emit({ sessionId: 'acp-1', type: 'delta', text: 'partial ' });
    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: 'done' });

    await flush();
    await flush();

    expect(acpManager.prompts).toHaveLength(2);
    expect(acpManager.prompts[1]).toMatchObject({
      agent: 'architect-agent',
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'architect please help' }],
    });
    expect(stream.updates).toContain('partial ');
    expect(stream.updates).toContain('FINAL:partial done');
  });

  it('includes a user-facing notice when ACP session restore falls back to a new session', async () => {
    const acpManager = new FakeAcpManager();
    acpManager.ensureSession = vi.fn().mockResolvedValue({
      sessionId: 'acp-2',
      resumed: false,
      fallbackFromLoad: true,
    });
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await store.put({
      sessionKey: 'THREAD#C1:123.456',
      acpSessionId: 'acp-old',
      activeAgent: 'senior-agent',
      inflight: false,
      queue: [],
      responseMode: 'thread_reply',
      lastUpdatedAt: new Date().toISOString(),
    });

    await runtime.enqueue(event('resume please'), channel, 'prompt');
    acpManager.emit({ sessionId: 'acp-2', type: 'final', text: 'fresh reply' });

    await flush();

    expect(stream.updates).toContain(
      'FINAL:Note: I could not restore the prior ACP session, so I started a new session for this reply.\n\nfresh reply'
    );
  });

  it('marks Slack message as failed when ACP errors', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('please fail'), channel, 'prompt');
    acpManager.emit({ sessionId: 'acp-1', type: 'error', error: 'boom' });

    await flush();

    expect(stream.failures).toContain('boom');
  });

  it('logs whether lookup used memory or GSI fallback', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    logger.logInfo.mockClear();
    logger.logWarn.mockClear();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('hello path'), channel, 'prompt');
    acpManager.emit({ sessionId: 'acp-1', type: 'delta', text: 'a' });
    await flush();

    expect(logger.logInfo).toHaveBeenCalledWith('ACP session lookup: memory-hit', expect.objectContaining({ acpSessionId: 'acp-1' }));

    (runtime as any).acpSessionIndex.clear();
    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: 'b' });
    await flush();

    expect(logger.logInfo).toHaveBeenCalledWith('ACP session lookup: gsi-fallback-hit', expect.objectContaining({ acpSessionId: 'acp-1' }));
  });

  it('falls back to sessionStore.getByAcpSessionId when reverse index is cold', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('hello fallback'), channel, 'prompt');
    // simulate process-local reverse index miss while Dynamo-backed state still exists
    (runtime as any).acpSessionIndex.clear();
    acpManager.emit({ sessionId: 'acp-1', type: 'delta', text: 'hi ' });
    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: 'there' });

    await flush();

    expect(stream.updates).toContain('hi ');
    expect(stream.updates).toContain('FINAL:hi there');
  });
});
