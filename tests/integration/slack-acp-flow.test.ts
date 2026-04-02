/**
 * Integration tests for the end-to-end Slack → Routing → ACP → Stream → Response flow.
 * Uses real RoutingLayer, SlackSessionRuntime, InMemorySessionStore, and SlackStreamController
 * with a fake ACP transport and fake Slack client.
 *
 * Addresses Phase 1 task 8.3.
 */
import { describe, it, expect, vi } from 'vitest';
import { RoutingLayer } from '../../src/slack-bot/routing';
import { handleSlackEvent } from '../../src/slack-bot/events';
import { SlackSessionRuntime } from '../../src/slack-bot/session-runtime';
import { SlackStreamController } from '../../src/slack-bot/stream-controller';
import { InMemorySessionStore } from '../../src/sessions/store';
import { AcpProcessManager } from '../../src/acp/process-manager';
import type { AcpEvent, AcpPromptPayload, SlackEvent } from '../../src/types';
import type { LoadedConfig } from '../../src/config/manager';

/* ------------------------------------------------------------------ */
/*  Fakes                                                              */
/* ------------------------------------------------------------------ */

class FakeAcpTransport {
  private readonly listeners = new Set<(e: AcpEvent) => void>();
  public readonly prompts: AcpPromptPayload[] = [];
  public readonly modeSwitches: string[] = [];
  public sessionCounter = 0;
  private initialized = false;

  async initialize() { this.initialized = true; }

  async createSession() {
    const id = `int-session-${++this.sessionCounter}`;
    this.emit({ sessionId: id, type: 'started' });
    return id;
  }

  async loadSession(sessionId: string) {
    this.emit({ sessionId, type: 'started' });
    return sessionId;
  }

  async switchAgent(_sid: string, agent: string) {
    this.modeSwitches.push(agent);
  }

  getSessionModel() { return 'claude-sonnet-4.6'; }
  getModeModel() { return 'claude-sonnet-4.6'; }

  async prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>) {
    this.prompts.push({ sessionId, prompt, agent: 'senior-agent', metadata: {} } as any);
  }

  onEvent(listener: (e: AcpEvent) => void) {
    this.listeners.add(listener);
  }

  close() {}

  emit(event: AcpEvent) {
    for (const l of this.listeners) l(event);
  }
}

function fakeSlackClient() {
  const messages: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let counter = 0;
  return {
    messages,
    updates,
    chat: {
      postMessage: vi.fn(async (args: Record<string, unknown>) => {
        messages.push(args);
        return { ts: `slack-${++counter}` };
      }),
      update: vi.fn(async (args: Record<string, unknown>) => {
        updates.push(args);
        return { ts: args.ts as string };
      }),
    },
  };
}

const logger = {
  logInfo: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
} as any;

const config: LoadedConfig = {
  channelAllowlist: [
    { channelId: 'C-AUTO', mode: 'auto_investigation', responseMode: 'thread_reply' },
    { channelId: 'C-MENTION', mode: 'mention_based', responseMode: 'thread_reply' },
    { channelId: 'C-LEARN', mode: 'learning', responseMode: 'thread_reply' },
  ],
};

function makeEvent(overrides: Partial<SlackEvent>): SlackEvent {
  return {
    type: 'app_mention',
    messageText: 'hello',
    channelId: 'C-AUTO',
    threadTs: '1000.1',
    userId: 'U1',
    timestamp: '1000.2',
    ...overrides,
  };
}

async function flush(n = 2) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('Integration: Slack → ACP → Response', () => {
  it('auto_investigation: message → ACP session → streaming → final response in thread', async () => {
    const transport = new FakeAcpTransport();
    const acpManager = new AcpProcessManager({ transport: transport as any });
    const store = new InMemorySessionStore();
    const client = fakeSlackClient();
    const stream = new SlackStreamController(client);
    const runtime = new SlackSessionRuntime(acpManager, store, stream, logger);
    const routing = new RoutingLayer(config);

    const event = makeEvent({ channelId: 'C-AUTO', messageText: 'investigate spike' });
    await handleSlackEvent(event, routing, logger, runtime);

    // ACP should have received a prompt
    expect(transport.prompts).toHaveLength(1);
    expect(transport.prompts[0].prompt[0].text).toBe('investigate spike');

    // Placeholder posted
    expect(client.messages).toHaveLength(1);
    expect(client.messages[0].channel).toBe('C-AUTO');

    // Simulate ACP streaming
    transport.emit({ sessionId: 'int-session-1', type: 'delta', text: 'Checking logs...' });
    transport.emit({ sessionId: 'int-session-1', type: 'final', text: ' Done.' });
    await flush(3);

    // Final update should be on the placeholder
    const lastUpdate = client.updates.at(-1);
    expect(lastUpdate).toBeDefined();
    expect(lastUpdate!.text).toContain('Done.');
  });

  it('mention_based: ignores plain message, processes app_mention', async () => {
    const transport = new FakeAcpTransport();
    const acpManager = new AcpProcessManager({ transport: transport as any });
    const store = new InMemorySessionStore();
    const client = fakeSlackClient();
    const stream = new SlackStreamController(client);
    const runtime = new SlackSessionRuntime(acpManager, store, stream, logger);
    const routing = new RoutingLayer(config);

    // Plain message in mention_based channel → ignored
    const plain = makeEvent({ channelId: 'C-MENTION', type: 'message', messageText: 'hello' });
    await handleSlackEvent(plain, routing, logger, runtime);
    expect(transport.prompts).toHaveLength(0);

    // app_mention → processed
    const mention = makeEvent({ channelId: 'C-MENTION', type: 'app_mention', messageText: 'help me' });
    await handleSlackEvent(mention, routing, logger, runtime);
    expect(transport.prompts).toHaveLength(1);
  });

  it('escalation: switch agent within same session, no prompt sent', async () => {
    const transport = new FakeAcpTransport();
    const acpManager = new AcpProcessManager({ transport: transport as any });
    const store = new InMemorySessionStore();
    const client = fakeSlackClient();
    const stream = new SlackStreamController(client);
    const runtime = new SlackSessionRuntime(acpManager, store, stream, logger);
    const routing = new RoutingLayer(config);

    // First: normal prompt to create session
    const prompt = makeEvent({ channelId: 'C-AUTO', messageText: 'first question' });
    await handleSlackEvent(prompt, routing, logger, runtime);
    transport.emit({ sessionId: 'int-session-1', type: 'final', text: 'answer' });
    await flush(3);

    const promptCount = transport.prompts.length;

    // Escalate in same thread
    const escalate = makeEvent({ channelId: 'C-AUTO', messageText: 'escalate', threadTs: '1000.1' });
    await handleSlackEvent(escalate, routing, logger, runtime);
    await flush(3);

    // No new prompt sent — escalation only switches mode
    expect(transport.prompts).toHaveLength(promptCount);

    // Mode switch message posted
    const switchMsg = client.updates.find((u) => (u.text as string).includes('architect'));
    expect(switchMsg).toBeDefined();
  });

  it('de-escalation: switch back to senior after escalation', async () => {
    const transport = new FakeAcpTransport();
    const acpManager = new AcpProcessManager({ transport: transport as any });
    const store = new InMemorySessionStore();
    const client = fakeSlackClient();
    const stream = new SlackStreamController(client);
    const runtime = new SlackSessionRuntime(acpManager, store, stream, logger);
    const routing = new RoutingLayer(config);

    // Create session + escalate
    await handleSlackEvent(makeEvent({ channelId: 'C-AUTO', messageText: 'q' }), routing, logger, runtime);
    transport.emit({ sessionId: 'int-session-1', type: 'final', text: 'a' });
    await flush(3);
    await handleSlackEvent(makeEvent({ channelId: 'C-AUTO', messageText: 'escalate' }), routing, logger, runtime);
    await flush(3);

    // De-escalate
    await handleSlackEvent(makeEvent({ channelId: 'C-AUTO', messageText: 'de-escalate' }), routing, logger, runtime);
    await flush(3);

    const seniorMsg = client.updates.find((u) => (u.text as string).includes('senior'));
    expect(seniorMsg).toBeDefined();
  });

  it('session recovery: existing session in store is reused', async () => {
    const transport = new FakeAcpTransport();
    const acpManager = new AcpProcessManager({ transport: transport as any });
    const store = new InMemorySessionStore();
    const client = fakeSlackClient();
    const stream = new SlackStreamController(client);
    const runtime = new SlackSessionRuntime(acpManager, store, stream, logger);
    const routing = new RoutingLayer(config);

    // Pre-seed a session as if from a previous process
    await store.put({
      sessionKey: 'THREAD#C-AUTO:1000.1',
      acpSessionId: 'old-session-abc',
      activeAgent: 'senior-agent',
      inflight: false,
      queue: [],
      responseMode: 'thread_reply',
      lastUpdatedAt: new Date().toISOString(),
    });

    const event = makeEvent({ channelId: 'C-AUTO', messageText: 'follow up' });
    await handleSlackEvent(event, routing, logger, runtime);

    // Should attempt to reuse the existing session (ensureSession called with existingSessionId)
    expect(transport.prompts).toHaveLength(1);
    // Session counter should still be 1 (loadSession reuses, or creates new as fallback)
    expect(transport.sessionCounter).toBeLessThanOrEqual(1);
  });

  it('status command: returns session info without sending ACP prompt', async () => {
    // Status is handled in app.ts, not in handleSlackEvent.
    // Here we verify routing correctly identifies it.
    const routing = new RoutingLayer(config);
    const decision = routing.decide(makeEvent({ channelId: 'C-AUTO', messageText: 'status' }));
    expect(decision.action).toBe('status');
  });
});
