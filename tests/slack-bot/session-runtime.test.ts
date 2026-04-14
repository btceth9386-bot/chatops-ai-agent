import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackSessionRuntime } from '../../src/slack-bot/session-runtime';
import { InMemorySessionStore } from '../../src/sessions/store';
import type { AcpEvent, AcpPromptPayload, ReactionsConfig, SlackEvent } from '../../src/types';

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

  public readonly agentSwitches: Array<{ sessionId: string; agent: string }> = [];

  async switchAgent(sessionId: string, agent: string): Promise<void> {
    this.agentSwitches.push({ sessionId, agent });
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

class FakeReactionClient {
  public readonly adds: Array<Record<string, unknown>> = [];
  public readonly removes: Array<Record<string, unknown>> = [];

  reactions = {
    add: vi.fn(async (args: Record<string, unknown>) => {
      this.adds.push(args);
      return {};
    }),
    remove: vi.fn(async (args: Record<string, unknown>) => {
      this.removes.push(args);
      return {};
    }),
  };
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

async function flushMicrotasks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

const reactionsConfig: ReactionsConfig = {
  enabled: true,
  removeAfterReply: true,
  emojis: {
    queued: 'eyes',
    thinking: 'brain',
    tool: 'wrench',
    coding: 'technologist',
    web: 'globe_with_meridians',
    done: 'white_check_mark',
    error: 'x',
    stallSoft: 'hourglass_flowing_sand',
    stallHard: 'turtle',
  },
  timing: {
    debounceMs: 5,
    stallSoftMs: 50,
    stallHardMs: 100,
    doneHoldMs: 10,
    errorHoldMs: 10,
  },
};

afterEach(() => {
  vi.useRealTimers();
});

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

    expect(acpManager.prompts).toHaveLength(1);
    expect(stream.updates).toContain('partial ');
    expect(stream.updates).toContain('FINAL:partial done');
    expect(stream.updates).toContain('FINAL:🔀 Switched to *architect* mode.');
  });

  it('de_escalation switches back to senior agent without sending a prompt', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    // First escalate to architect
    await runtime.enqueue(event('escalate'), channel, 'escalation');
    await flush();

    // Then de-escalate back to senior
    await runtime.enqueue(event('de-escalate'), channel, 'de_escalation');
    await flush();

    expect(acpManager.agentSwitches).toContainEqual({ sessionId: 'acp-1', agent: 'architect-agent' });
    expect(acpManager.agentSwitches).toContainEqual({ sessionId: 'acp-1', agent: 'senior-agent' });
    expect(stream.updates).toContain('FINAL:🔀 Switched to *architect* mode.');
    expect(stream.updates).toContain('FINAL:🔀 Switched to *senior* mode.');
    expect(acpManager.prompts).toHaveLength(0);
  });

  it('restores agent mode via switchAgent when resuming a session on a new ACP process', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    // Pre-seed state as if architect was active before restart
    await store.put({
      sessionKey: 'THREAD#C1:123.456',
      acpSessionId: 'acp-old',
      activeAgent: 'architect-agent',
      inflight: false,
      queue: [],
      responseMode: 'thread_reply',
      lastUpdatedAt: new Date().toISOString(),
    });

    acpManager.ensureSession = vi.fn().mockResolvedValue({
      sessionId: 'acp-new',
      resumed: true,
      fallbackFromLoad: false,
    });

    await runtime.enqueue(event('hello after restart'), channel, 'prompt');
    acpManager.emit({ sessionId: 'acp-new', type: 'final', text: 'architect reply' });
    await flush();

    // Should have restored architect mode on the new session
    expect(acpManager.agentSwitches).toContainEqual({ sessionId: 'acp-new', agent: 'architect-agent' });
    expect(stream.updates).toContain('FINAL:architect reply');
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

  it('renders tool lines above streaming text and dedupes updates by toolCallId', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('investigate'), channel, 'prompt');

    acpManager.emit({ sessionId: 'acp-1', type: 'tool_start', toolCallId: 'tool-1', title: 'Query Grafana' });
    acpManager.emit({ sessionId: 'acp-1', type: 'delta', text: 'Looking into it' });
    acpManager.emit({ sessionId: 'acp-1', type: 'tool_start', toolCallId: 'tool-1', title: 'Query Grafana dashboard' });
    acpManager.emit({ sessionId: 'acp-1', type: 'tool_done', toolCallId: 'tool-1', title: '', status: 'completed' });
    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: ' now' });

    await flush();

    expect(stream.updates).toContain("🔧 `Query Grafana`...");
    expect(stream.updates).toContain("🔧 `Query Grafana`...\n\nLooking into it");
    expect(stream.updates).toContain("🔧 `Query Grafana dashboard`...\n\nLooking into it");
    expect(stream.updates).toContain("✅ `Query Grafana dashboard`\n\nLooking into it");
    expect(stream.updates).toContain("FINAL:✅ `Query Grafana dashboard`\n\nLooking into it now");
  });

  it('renders failed tools and sanitizes multiline titles', async () => {
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('investigate'), channel, 'prompt');

    acpManager.emit({
      sessionId: 'acp-1',
      type: 'tool_done',
      toolCallId: 'tool-2',
      title: "cat `file`\nerror",
      status: 'failed',
    });
    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: 'done' });

    await flush();

    expect(stream.updates).toContain("❌ `cat 'file' ; error`");
    expect(stream.updates).toContain("FINAL:❌ `cat 'file' ; error`\n\ndone");
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

  it('updates reactions across queued, tool, thinking, and done states', async () => {
    vi.useFakeTimers();
    const acpManager = new FakeAcpManager();
    const store = new InMemorySessionStore();
    const stream = new FakeStreamController();
    const reactions = new FakeReactionClient();
    const runtime = new SlackSessionRuntime(acpManager as any, store, stream as any, logger, reactions as any, reactionsConfig);
    const channel = { channelId: 'C1', mode: 'auto_investigation', responseMode: 'thread_reply' } as const;

    await runtime.enqueue(event('check the web'), channel, 'prompt');
    await flushMicrotasks();

    expect(reactions.adds[0]).toMatchObject({
      channel: 'C1',
      timestamp: '123.456',
      name: 'eyes',
    });

    acpManager.emit({ sessionId: 'acp-1', type: 'tool', toolName: 'web_search' });
    await vi.advanceTimersByTimeAsync(5);
    expect(reactions.adds.at(-1)).toMatchObject({ name: 'globe_with_meridians' });

    acpManager.emit({ sessionId: 'acp-1', type: 'delta', text: 'partial ' });
    await vi.advanceTimersByTimeAsync(5);
    expect(reactions.adds.at(-1)).toMatchObject({ name: 'brain' });

    acpManager.emit({ sessionId: 'acp-1', type: 'final', text: 'done' });
    await flushMicrotasks(10);
    expect(reactions.adds.at(-1)).toMatchObject({ name: 'white_check_mark' });

    await vi.advanceTimersByTimeAsync(10);
    expect(reactions.removes.at(-1)).toMatchObject({ name: 'white_check_mark' });
  });
});
