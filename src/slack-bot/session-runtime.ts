import type { AcpEvent, AgentName, ChannelConfig, SessionRequest, SessionState, SlackEvent } from '../types';
import type { AcpProcessManager } from '../acp/process-manager';
import type { SessionStore } from '../sessions/store';
import type { CloudWatchLogger } from '../logging/cloudwatch';
import type { SlackStreamController } from './stream-controller';

function buildSessionKey(channelId: string, threadTs: string): string {
  return `THREAD#${channelId}:${threadTs}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

export class SlackSessionRuntime {
  private readonly sessionTargets = new Map<string, ChannelConfig & { threadTs: string }>();
  private readonly sessionBuffers = new Map<string, string>();
  private readonly perSessionLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly acpManager: AcpProcessManager,
    private readonly sessionStore: SessionStore,
    private readonly streamController: SlackStreamController,
    private readonly logger: CloudWatchLogger
  ) {
    this.acpManager.onEvent((event) => {
      void this.handleAcpEvent(event);
    });
  }

  async enqueue(event: SlackEvent, channel: ChannelConfig, kind: 'prompt' | 'escalation'): Promise<void> {
    const sessionKey = buildSessionKey(event.channelId, event.threadTs);
    const request: SessionRequest = {
      messageText: event.messageText,
      channelId: event.channelId,
      threadTs: event.threadTs,
      userId: event.userId,
      timestamp: event.timestamp,
      kind,
    };

    await this.withLock(sessionKey, async () => {
      const existing = (await this.sessionStore.get(sessionKey)) ?? {
        sessionKey,
        acpSessionId: '',
        activeAgent: 'senior-agent' as AgentName,
        inflight: false,
        queue: [],
        responseMode: channel.responseMode,
        lastUpdatedAt: isoNow(),
      };

      existing.queue.push(request);
      existing.responseMode = channel.responseMode;
      existing.lastUpdatedAt = isoNow();
      await this.sessionStore.put(existing);
      this.sessionTargets.set(sessionKey, { ...channel, threadTs: event.threadTs });

      if (!existing.inflight) {
        await this.processNext(sessionKey);
      }
    });
  }

  private async processNext(sessionKey: string): Promise<void> {
    const state = await this.sessionStore.get(sessionKey);
    if (!state || state.inflight || state.queue.length === 0) {
      return;
    }

    const next = state.queue[0];
    const target = this.sessionTargets.get(sessionKey) ?? {
      channelId: next.channelId,
      threadTs: next.threadTs,
      responseMode: state.responseMode,
    };

    const activeAgent: AgentName = next.kind === 'escalation' ? 'architect-agent' : state.activeAgent || 'senior-agent';
    const acpSessionId = await this.acpManager.ensureSession(
      sessionKey,
      state.acpSessionId || undefined,
      activeAgent
    );
    const statusMessageTs = await this.streamController.ensurePlaceholder(target, state.statusMessageTs);
    this.sessionBuffers.set(acpSessionId, '');

    await this.sessionStore.put({
      ...state,
      acpSessionId,
      activeAgent,
      inflight: true,
      statusMessageTs,
      lastUpdatedAt: isoNow(),
    });

    await this.logger.logInfo('Dispatching ACP request', {
      component: 'session-runtime',
      sessionKey,
      acpSessionId,
      requestKind: next.kind,
      agent: activeAgent,
    });

    await this.acpManager.sendPrompt({
      sessionId: acpSessionId,
      content: [
        {
          type: 'text',
          text: next.messageText,
        },
      ],
      agent: activeAgent,
      metadata: {
        channelId: next.channelId,
        threadTs: next.threadTs,
        userId: next.userId,
        requestKind: next.kind ?? 'prompt',
      },
    });
  }

  private async handleAcpEvent(event: AcpEvent): Promise<void> {
    const state = await this.findStateByAcpSessionId(event.sessionId);
    if (!state) {
      return;
    }

    const target = this.sessionTargets.get(state.sessionKey);
    if (!target || !state.statusMessageTs) {
      return;
    }

    if (event.type === 'delta') {
      const nextBuffer = `${this.sessionBuffers.get(event.sessionId) ?? ''}${event.text ?? ''}`;
      this.sessionBuffers.set(event.sessionId, nextBuffer);
      await this.streamController.pushDelta(target, state.statusMessageTs, nextBuffer);
      return;
    }

    if (event.type === 'error') {
      await this.streamController.fail(target, state.statusMessageTs, event.error ?? 'Unknown ACP error');
      await this.finishCurrent(state, false);
      return;
    }

    if (event.type === 'final') {
      const finalText = `${this.sessionBuffers.get(event.sessionId) ?? ''}${event.text ?? ''}`;
      await this.streamController.complete(target, state.statusMessageTs, finalText);
      await this.finishCurrent(state, true);
    }
  }

  private async finishCurrent(state: SessionState, preserveAgent: boolean): Promise<void> {
    const [, ...remaining] = state.queue;
    const nextState: SessionState = {
      ...state,
      inflight: false,
      queue: remaining,
      activeAgent: preserveAgent ? state.activeAgent : 'senior-agent',
      lastUpdatedAt: isoNow(),
    };

    await this.sessionBuffers.delete(state.acpSessionId);
    await this.sessionStore.put(nextState);
    await this.processNext(state.sessionKey);
  }

  private async findStateByAcpSessionId(acpSessionId: string): Promise<SessionState | null> {
    for (const sessionKey of this.sessionTargets.keys()) {
      const state = await this.sessionStore.get(sessionKey);
      if (state?.acpSessionId === acpSessionId) {
        return state;
      }
    }

    return null;
  }

  private async withLock(sessionKey: string, work: () => Promise<void>): Promise<void> {
    const previous = this.perSessionLocks.get(sessionKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.perSessionLocks.set(sessionKey, previous.then(() => current));

    await previous;
    try {
      await work();
    } finally {
      release();
      if (this.perSessionLocks.get(sessionKey) === current) {
        this.perSessionLocks.delete(sessionKey);
      }
    }
  }
}
