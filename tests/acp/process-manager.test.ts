import { describe, expect, it } from 'vitest';
import { AcpProcessManager } from '../../src/acp/process-manager';
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
  it('reuses the same ACP session for repeated lookups of the same Slack thread', async () => {
    const transport = new FakeTransport();
    const manager = new AcpProcessManager({ transport: transport as any });

    const first = await manager.ensureSession('THREAD#C1:123.456');
    const second = await manager.ensureSession('THREAD#C1:123.456');

    expect(first).toBe('acp-1');
    expect(second).toBe('acp-1');
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

    await expect(first).resolves.toBe('acp-1');
    await expect(second).resolves.toBe('acp-1');
    expect(transport.createSessionCalls).toBe(1);
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
});
