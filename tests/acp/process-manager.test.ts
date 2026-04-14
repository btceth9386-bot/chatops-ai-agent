import { describe, expect, it, vi } from 'vitest';
import { AcpProcessManager, classifySessionUpdateEvent } from '../../src/acp/process-manager';
import type { AcpEvent } from '../../src/types';

class FakeTransport {
  public initializeCalls = 0;
  public createSessionCalls = 0;
  public closeCalls = 0;
  public prompts: Array<{ sessionId: string; prompt: Array<{ type: 'text'; text: string }> }> = [];
  private readonly listeners = new Set<(event: AcpEvent) => void>();

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async createSession(): Promise<string> {
    this.createSessionCalls += 1;
    return `acp-${this.createSessionCalls}`;
  }

  async loadSession(sessionId: string): Promise<string> {
    return sessionId;
  }

  async switchAgent(): Promise<void> {}

  getSessionModel(): string | undefined {
    return undefined;
  }

  getModeModel(_modeId?: string): string | undefined {
    return undefined;
  }

  async prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<void> {
    this.prompts.push({ sessionId, prompt });
  }

  onEvent(listener: (event: AcpEvent) => void): void {
    this.listeners.add(listener);
  }

  close(): void {
    this.closeCalls += 1;
  }

  emit(event: AcpEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

describe('AcpProcessManager', () => {
  it('classifies tool_call and tool_call_update notifications using toolCallId', () => {
    expect(classifySessionUpdateEvent({
      sessionId: 'acp-1',
      update: {
        type: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
      },
    })).toEqual({
      sessionId: 'acp-1',
      type: 'tool_start',
      toolCallId: 'tool-1',
      title: 'Read file',
    });

    expect(classifySessionUpdateEvent({
      sessionId: 'acp-1',
      update: {
        type: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read src/config/app.json',
        status: 'completed',
      },
    })).toEqual({
      sessionId: 'acp-1',
      type: 'tool_done',
      toolCallId: 'tool-1',
      title: 'Read src/config/app.json',
      status: 'completed',
    });
  });

  it('treats in-progress tool_call_update as a refined tool_start and ignores missing ids', () => {
    expect(classifySessionUpdateEvent({
      sessionId: 'acp-1',
      update: {
        type: 'tool_call_update',
        toolCallId: 'tool-2',
        title: 'Query Grafana dashboard',
        status: 'running',
      },
    })).toEqual({
      sessionId: 'acp-1',
      type: 'tool_start',
      toolCallId: 'tool-2',
      title: 'Query Grafana dashboard',
    });

    expect(classifySessionUpdateEvent({
      sessionId: 'acp-1',
      update: {
        type: 'tool_call',
        title: 'Missing ID',
      },
    })).toBeNull();
  });

  it('reuses the same ACP session for repeated lookups of the same Slack thread', async () => {
    const transport = new FakeTransport();
    const manager = new AcpProcessManager({ transport: transport as any });

    const first = await manager.ensureSession('THREAD#C1:123.456');
    const second = await manager.ensureSession('THREAD#C1:123.456');

    expect(first).toMatchObject({
      sessionId: 'acp-1',
      resumed: false,
      fallbackFromLoad: false,
    });
    expect(second).toMatchObject({
      sessionId: 'acp-1',
      resumed: true,
      fallbackFromLoad: false,
    });
    expect(transport.createSessionCalls).toBe(1);
  });

  it('serializes concurrent session creation for the same thread', async () => {
    let resolveCreate!: (value: string) => void;
    const transport = new FakeTransport();
    transport.createSession = () => {
      transport.createSessionCalls += 1;
      return new Promise<string>((resolve) => {
        resolveCreate = resolve;
      });
    };

    const manager = new AcpProcessManager({ transport: transport as any });
    const first = manager.ensureSession('THREAD#C1:123.456');
    const second = manager.ensureSession('THREAD#C1:123.456');

    resolveCreate('acp-1');

    await expect(first).resolves.toMatchObject({
      sessionId: 'acp-1',
      resumed: false,
      fallbackFromLoad: false,
    });
    await expect(second).resolves.toMatchObject({
      sessionId: 'acp-1',
      resumed: false,
      fallbackFromLoad: false,
    });
    expect(transport.createSessionCalls).toBe(1);
  });

  it('restores an existing ACP session via session/load when a prior session id is present', async () => {
    const transport = new FakeTransport();
    transport.loadSession = vi.fn().mockResolvedValue('acp-restored');
    const manager = new AcpProcessManager({ transport: transport as any });

    const result = await manager.ensureSession('THREAD#C1:123.456', 'acp-old', 'senior-agent');

    expect(transport.loadSession).toHaveBeenCalledWith('acp-old');
    expect(result).toMatchObject({
      sessionId: 'acp-restored',
      resumed: true,
      fallbackFromLoad: false,
    });
    expect(transport.createSessionCalls).toBe(0);
  });

  it('falls back to session/new when session/load fails for an existing ACP session id', async () => {
    const transport = new FakeTransport();
    transport.loadSession = vi.fn().mockRejectedValue(new Error('restore failed'));
    const manager = new AcpProcessManager({ transport: transport as any });
    (manager as any).recycleTransport = vi.fn();

    const result = await manager.ensureSession('THREAD#C1:123.456', 'acp-old', 'senior-agent');

    expect(transport.loadSession).toHaveBeenCalledWith('acp-old');
    expect(result).toMatchObject({
      sessionId: 'acp-1',
      resumed: false,
      fallbackFromLoad: true,
    });
    expect(transport.createSessionCalls).toBe(1);
  });

  it('suppresses session/update events emitted during session/load (history replay)', async () => {
    const transport = new FakeTransport();
    const events: AcpEvent[] = [];

    // Simulate: loadSession emits deltas during load (ACP history replay)
    transport.loadSession = async (sessionId: string) => {
      transport.emit({ sessionId, type: 'delta', text: 'replayed user msg' });
      transport.emit({ sessionId, type: 'delta', text: 'replayed agent msg' });
      return sessionId;
    };

    const manager = new AcpProcessManager({ transport: transport as any });
    manager.onEvent((e) => events.push(e));

    await manager.ensureSession('THREAD#C1:123.456', 'acp-old', 'senior-agent');

    // Events emitted during load should have been suppressed
    // Only the 'started' event from ensureSession should come through
    const deltasDuringLoad = events.filter((e) => e.type === 'delta');
    expect(deltasDuringLoad).toHaveLength(0);
  });

  it('allows delta events after session/load completes', async () => {
    const transport = new FakeTransport();
    const events: AcpEvent[] = [];

    transport.loadSession = async (sessionId: string) => {
      transport.emit({ sessionId, type: 'delta', text: 'replayed' });
      return sessionId;
    };

    const manager = new AcpProcessManager({ transport: transport as any });
    manager.onEvent((e) => events.push(e));

    await manager.ensureSession('THREAD#C1:123.456', 'acp-old', 'senior-agent');

    // After load completes, new deltas should come through
    transport.emit({ sessionId: 'acp-old', type: 'delta', text: 'real response' });

    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].text).toBe('real response');
  });

  it('forwards transport events to listeners', async () => {
    const transport = new FakeTransport();
    const manager = new AcpProcessManager({ transport: transport as any });
    const events: AcpEvent[] = [];

    manager.onEvent((event) => events.push(event));
    transport.emit({ sessionId: 'acp-1', type: 'delta', text: 'hello' });

    expect(events).toEqual([{ sessionId: 'acp-1', type: 'delta', text: 'hello' }]);
  });

  it('sends ACP prompts using prompt arrays rather than legacy string payloads', async () => {
    const transport = new FakeTransport();
    const manager = new AcpProcessManager({ transport: transport as any });

    await manager.sendPrompt({
      sessionId: 'acp-1',
      prompt: [{ type: 'text', text: 'hello from slack' }],
      agent: 'senior-agent',
      metadata: {
        channelId: 'C1',
        threadTs: '123.456',
        userId: 'U1',
        requestKind: 'prompt',
      },
    });

    expect(transport.prompts).toEqual([
      {
        sessionId: 'acp-1',
        prompt: [{ type: 'text', text: 'hello from slack' }],
      },
    ]);
  });

  it('closes the underlying transport', () => {
    const transport = new FakeTransport();
    const manager = new AcpProcessManager({ transport: transport as any });

    manager.close();

    expect(transport.closeCalls).toBe(1);
  });

  it('getModeModel falls back to agent config when sessionModels is empty', async () => {
    const transport = new FakeTransport();
    const modeModelMap = new Map<string, string>();
    modeModelMap.set('senior', 'claude-sonnet-4.6');
    transport.getModeModel = (modeId?: string) => modeModelMap.get(modeId ?? '');

    const manager = new AcpProcessManager({ transport: transport as any });

    // No session loaded yet — getSessionModel returns undefined
    expect(manager.getSessionModel('nonexistent')).toBeUndefined();

    // getModeModel delegates to transport which has 'senior' but not 'nonexistent'
    expect(manager.getModeModel('senior')).toBe('claude-sonnet-4.6');
    expect(manager.getModeModel('nonexistent_mode')).toBeUndefined();
  });
});
