import type { AcpEvent, AgentName, ChannelConfig, ReactionsConfig, SessionRequest, SessionState, SlackEvent } from '../types';
import type { AcpProcessManager } from '../acp/process-manager';
import type { SessionStore } from '../sessions/store';
import type { CloudWatchLogger } from '../logging/cloudwatch';
import type { SlackStreamController } from './stream-controller';
import type { SlackReactionClientLike } from './reactions';
import { createLogger } from '../logging/logger';
import { SlackReactionController } from './reactions';

const log = createLogger('session-runtime');

type ToolEntry = {
  id: string;
  title: string;
  state: 'running' | 'completed' | 'failed';
};

function buildSessionKey(channelId: string, threadTs: string): string {
  return `THREAD#${channelId}:${threadTs}`;
}

function isoNow(): string {
  return new Date().toISOString();
}

function sanitizeToolTitle(title: string): string {
  return title.replace(/\n/g, ' ; ').replace(/`/g, "'");
}

function renderToolLine(entry: ToolEntry): string {
  const icon = entry.state === 'running' ? '🔧' : entry.state === 'completed' ? '✅' : '❌';
  const suffix = entry.state === 'running' ? '...' : '';
  return `${icon} \`${sanitizeToolTitle(entry.title)}\`${suffix}`;
}

function composeDisplay(toolEntries: ToolEntry[], textBuffer: string): string {
  const toolLines = toolEntries.map((entry) => renderToolLine(entry)).join('\n');
  if (!toolLines) {
    return textBuffer;
  }

  if (!textBuffer) {
    return toolLines;
  }

  return `${toolLines}\n\n${textBuffer}`;
}

export class SlackSessionRuntime {
  private readonly sessionTargets = new Map<string, ChannelConfig & { threadTs: string }>();
  private readonly sessionBuffers = new Map<string, string>();
  private readonly sessionToolEntries = new Map<string, ToolEntry[]>();
  private readonly acpSessionIndex = new Map<string, string>();
  private readonly perSessionLocks = new Map<string, Promise<void>>();
  private readonly perAcpEventLocks = new Map<string, Promise<void>>();
  private readonly activeReactionKeys = new Map<string, string>();
  private readonly reactionControllers = new Map<string, SlackReactionController>();

  constructor(
    private readonly acpManager: AcpProcessManager,
    private readonly sessionStore: SessionStore,
    private readonly streamController: SlackStreamController,
    private readonly logger: CloudWatchLogger,
    private readonly reactionClient?: SlackReactionClientLike,
    private readonly reactionsConfig?: ReactionsConfig
  ) {
    this.acpManager.onEvent((event) => {
      void this.handleAcpEvent(event);
    });
  }

  async enqueue(event: SlackEvent, channel: ChannelConfig, kind: 'prompt' | 'escalation' | 'de_escalation'): Promise<void> {
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

      if (existing.inflight && !this.acpManager.hasSession(sessionKey, existing.acpSessionId || undefined)) {
        log.warn('stale inflight recovered', {
          sessionKey,
          acpSessionId: existing.acpSessionId,
          queuedBefore: existing.queue.length,
        });
        existing.inflight = false;
        existing.acpSessionId = '';
        existing.statusMessageTs = undefined;
      }

      existing.queue.push(request);
      existing.responseMode = channel.responseMode;
      if (!existing.inflight) {
        existing.statusMessageTs = undefined;
      }
      existing.lastUpdatedAt = isoNow();
      await this.sessionStore.put(existing);
      this.sessionTargets.set(sessionKey, { ...channel, threadTs: event.threadTs });
      const reactionController = this.getReactionController(sessionKey, request);
      if (reactionController) {
        this.fireAndForgetReaction(sessionKey, 'setQueued', () => reactionController.setQueued());
      }

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
    const requestReactionKey = this.buildReactionKey(sessionKey, next.timestamp);
    const target = this.sessionTargets.get(sessionKey) ?? {
      channelId: next.channelId,
      threadTs: next.threadTs,
      responseMode: state.responseMode,
    };
    this.activeReactionKeys.set(sessionKey, requestReactionKey);

    const isModeSwitch = next.kind === 'escalation' || next.kind === 'de_escalation';
    const targetAgent: AgentName = next.kind === 'escalation' ? 'architect-agent' : next.kind === 'de_escalation' ? 'senior-agent' : state.activeAgent || 'senior-agent';
    const activeAgent: AgentName = isModeSwitch ? targetAgent : state.activeAgent || 'senior-agent';
    const ensureResult = await this.acpManager.ensureSession(
      sessionKey,
      state.acpSessionId || undefined,
      activeAgent
    );
    const acpSessionId = ensureResult.sessionId;

    if (isModeSwitch && state.activeAgent !== targetAgent) {
      try {
        await this.acpManager.switchAgent(acpSessionId, targetAgent);
      } catch (err) {
        log.warn('agent switch failed, continuing with current agent', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (!isModeSwitch && ensureResult.resumed && activeAgent !== 'senior-agent') {
      try {
        await this.acpManager.switchAgent(acpSessionId, activeAgent);
      } catch (err) {
        log.warn('agent restore after load failed', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (isModeSwitch) {
      const modeName = targetAgent === 'architect-agent' ? 'architect' : 'senior';
      const statusMessageTs = await this.streamController.ensurePlaceholder(target, state.statusMessageTs);
      await this.streamController.complete(target, statusMessageTs, `🔀 Switched to *${modeName}* mode.`);
      this.fireAndForgetReaction(sessionKey, 'setDone', () => this.getActiveReactionController(sessionKey)?.setDone() ?? Promise.resolve());
      const updatedState: SessionState = {
        ...state,
        acpSessionId,
        activeAgent,
        statusMessageTs,
        lastUpdatedAt: isoNow(),
      };
      await this.sessionStore.put(updatedState);
      await this.finishCurrent(updatedState, true);
      return;
    }

    const statusMessageTs = await this.streamController.ensurePlaceholder(target, state.statusMessageTs);
    this.sessionBuffers.set(acpSessionId, '');
    this.sessionToolEntries.set(acpSessionId, []);
    this.acpSessionIndex.set(acpSessionId, sessionKey);

    const sessionNotice = ensureResult.fallbackFromLoad
      ? 'Note: I could not restore the prior ACP session, so I started a new session for this reply.'
      : undefined;

    await this.sessionStore.put({
      ...state,
      acpSessionId,
      activeAgent,
      inflight: true,
      statusMessageTs,
      sessionNotice,
      lastUpdatedAt: isoNow(),
    });

    await this.logger.logInfo('Dispatching ACP request', {
      component: 'session-runtime',
      sessionKey,
      acpSessionId,
      requestKind: next.kind,
      agent: activeAgent,
    });

    this.sessionBuffers.set(acpSessionId, '');
    await this.acpManager.sendPrompt({
      sessionId: acpSessionId,
      prompt: [
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
    await this.withAcpEventLock(event.sessionId, async () => {
      log.debug('handleAcpEvent received', {
        sessionId: event.sessionId,
        type: event.type,
        hasText: 'text' in event && Boolean(event.text),
        hasError: 'error' in event && Boolean(event.error),
      });

      const state = await this.findStateByAcpSessionId(event.sessionId);
      if (!state) {
        log.debug('handleAcpEvent state-miss', {
          sessionId: event.sessionId,
          type: event.type,
        });
        return;
      }

      const target = this.sessionTargets.get(state.sessionKey);
      if (!target || !state.statusMessageTs) {
        return;
      }

      if (event.type === 'tool') {
        this.fireAndForgetReaction(state.sessionKey, 'setTool', () => this.getActiveReactionController(state.sessionKey)?.setTool(event.toolName ?? '') ?? Promise.resolve());
        return;
      }

      if (event.type === 'delta') {
        this.fireAndForgetReaction(state.sessionKey, 'setThinking', () => this.getActiveReactionController(state.sessionKey)?.setThinking() ?? Promise.resolve());
        const nextBuffer = `${this.sessionBuffers.get(event.sessionId) ?? ''}${event.text ?? ''}`;
        this.sessionBuffers.set(event.sessionId, nextBuffer);
        const displayText = composeDisplay(this.sessionToolEntries.get(event.sessionId) ?? [], nextBuffer);
        await this.streamController.pushDelta(target, state.statusMessageTs, displayText);
        return;
      }

      if (event.type === 'tool_start') {
        const nextEntries = this.upsertToolEntry(event.sessionId, event.toolCallId, event.title, 'running');
        await this.streamController.pushDelta(
          target,
          state.statusMessageTs,
          composeDisplay(nextEntries, this.sessionBuffers.get(event.sessionId) ?? '')
        );
        return;
      }

      if (event.type === 'tool_done') {
        const nextEntries = this.upsertToolEntry(event.sessionId, event.toolCallId, event.title, event.status);
        await this.streamController.pushDelta(
          target,
          state.statusMessageTs,
          composeDisplay(nextEntries, this.sessionBuffers.get(event.sessionId) ?? '')
        );
        return;
      }

      if (event.type === 'error') {
        this.fireAndForgetReaction(state.sessionKey, 'setError', () => this.getActiveReactionController(state.sessionKey)?.setError() ?? Promise.resolve());
        await this.streamController.fail(target, state.statusMessageTs, event.error ?? 'Unknown ACP error');
        await this.finishCurrent(state, false);
        return;
      }

      if (event.type === 'final') {
        const bufferedText = this.sessionBuffers.get(event.sessionId) ?? '';
        const finalText = event.preserveBuffer ? bufferedText : `${bufferedText}${event.text ?? ''}`;
        const displayText = composeDisplay(this.sessionToolEntries.get(event.sessionId) ?? [], finalText);
        const decoratedFinalText = state.sessionNotice ? `${state.sessionNotice}\n\n${displayText}` : displayText;
        log.debug('handleAcpEvent final', {
          sessionId: event.sessionId,
          preserveBuffer: Boolean(event.preserveBuffer),
          bufferedLength: bufferedText.length,
          eventTextLength: (event.text ?? '').length,
          finalLength: finalText.length,
          hasSessionNotice: Boolean(state.sessionNotice),
        });
        this.fireAndForgetReaction(state.sessionKey, 'setDone', () => this.getActiveReactionController(state.sessionKey)?.setDone() ?? Promise.resolve());
        await this.streamController.complete(target, state.statusMessageTs, decoratedFinalText);
        await this.finishCurrent(state, true);
      }
    });
  }

  private async finishCurrent(state: SessionState, preserveAgent: boolean): Promise<void> {
    const [, ...remaining] = state.queue;
    const activeReactionKey = this.activeReactionKeys.get(state.sessionKey);
    const nextState: SessionState = {
      ...state,
      inflight: false,
      queue: remaining,
      activeAgent: preserveAgent ? state.activeAgent : 'senior-agent',
      sessionNotice: undefined,
      lastUpdatedAt: isoNow(),
    };

    this.sessionBuffers.delete(state.acpSessionId);
    this.sessionToolEntries.delete(state.acpSessionId);
    this.activeReactionKeys.delete(state.sessionKey);
    if (activeReactionKey) {
      this.reactionControllers.delete(activeReactionKey);
    }
    await this.sessionStore.put(nextState);
    await this.processNext(state.sessionKey);
  }

  private buildReactionKey(sessionKey: string, timestamp: string): string {
    return `${sessionKey}:${timestamp}`;
  }

  private getReactionController(sessionKey: string, request: SessionRequest): SlackReactionController | null {
    if (!this.reactionClient || !this.reactionsConfig?.enabled) {
      return null;
    }

    const key = this.buildReactionKey(sessionKey, request.timestamp);
    const existing = this.reactionControllers.get(key);
    if (existing) {
      return existing;
    }

    const controller = new SlackReactionController(this.reactionClient, {
      channelId: request.channelId,
      messageTs: request.timestamp,
    }, this.reactionsConfig);
    this.reactionControllers.set(key, controller);
    return controller;
  }

  private getActiveReactionController(sessionKey: string): SlackReactionController | null {
    const reactionKey = this.activeReactionKeys.get(sessionKey);
    if (!reactionKey) {
      return null;
    }

    return this.reactionControllers.get(reactionKey) ?? null;
  }

  private fireAndForgetReaction(sessionKey: string, action: string, work: () => Promise<void>): void {
    void work().catch((error) => {
      log.warn('reaction update failed', {
        sessionKey,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private upsertToolEntry(
    acpSessionId: string,
    toolCallId: string,
    title: string,
    state: ToolEntry['state']
  ): ToolEntry[] {
    const entries = [...(this.sessionToolEntries.get(acpSessionId) ?? [])];
    const existingIndex = entries.findIndex((entry) => entry.id === toolCallId);
    const nextTitle = title || entries[existingIndex]?.title || '';

    if (existingIndex === -1) {
      entries.push({
        id: toolCallId,
        title: nextTitle,
        state,
      });
    } else {
      entries[existingIndex] = {
        ...entries[existingIndex],
        title: nextTitle,
        state,
      };
    }

    this.sessionToolEntries.set(acpSessionId, entries);
    return entries;
  }

  private async findStateByAcpSessionId(acpSessionId: string): Promise<SessionState | null> {
    log.debug('findStateByAcpSessionId:start', { acpSessionId });

    const indexedSessionKey = this.acpSessionIndex.get(acpSessionId);
    if (indexedSessionKey) {
      log.debug('findStateByAcpSessionId:memory-hit', { acpSessionId, sessionKey: indexedSessionKey });
      await this.logger.logInfo('ACP session lookup: memory-hit', {
        component: 'session-runtime',
        acpSessionId,
        sessionKey: indexedSessionKey,
      });
      return await this.sessionStore.get(indexedSessionKey);
    }

    log.debug('findStateByAcpSessionId:query-gsi', { acpSessionId });
    const state = await this.sessionStore.getByAcpSessionId(acpSessionId);
    if (state) {
      log.info('findStateByAcpSessionId:gsi-hit', { acpSessionId, sessionKey: state.sessionKey });
      this.acpSessionIndex.set(acpSessionId, state.sessionKey);
      await this.logger.logInfo('ACP session lookup: gsi-fallback-hit', {
        component: 'session-runtime',
        acpSessionId,
        sessionKey: state.sessionKey,
      });
      return state;
    }

    log.warn('findStateByAcpSessionId:miss', { acpSessionId });
    await this.logger.logWarn('ACP session lookup: miss', {
      component: 'session-runtime',
      acpSessionId,
    });
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

  private async withAcpEventLock(acpSessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.perAcpEventLocks.get(acpSessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.perAcpEventLocks.set(acpSessionId, previous.then(() => current));

    await previous;
    try {
      await work();
    } finally {
      release();
      if (this.perAcpEventLocks.get(acpSessionId) === current) {
        this.perAcpEventLocks.delete(acpSessionId);
      }
    }
  }
}
