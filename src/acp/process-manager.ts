import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AcpEvent, AcpPromptPayload, AgentName } from '../types';
import { createLogger } from '../logging/logger';

const JSON_RPC_VERSION = '2.0';
const ACP_PROTOCOL_VERSION = 1;
const ACP_REQUEST_TIMEOUT_MS = 60_000;
const ACP_LOAD_TIMEOUT_MS = 30_000;

const log = createLogger('acp');

type JsonRpcId = number | string;

interface JsonRpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

interface AcpTransport {
  initialize(): Promise<void>;
  createSession(agent?: AgentName): Promise<string>;
  loadSession(sessionId: string): Promise<string>;
  switchAgent(sessionId: string, agent: AgentName): Promise<void>;
  prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<void>;
  getSessionModel(sessionId: string): string | undefined;
  getModeModel(modeId: string): string | undefined;
  onEvent(listener: (event: AcpEvent) => void): void;
  close(): void;
}

export interface AcpManagerOptions {
  transport?: AcpTransport;
  command?: string;
}

export interface EnsureSessionResult {
  sessionId: string;
  resumed: boolean;
  fallbackFromLoad: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => collectText(item)).filter(Boolean).join('');
  }

  const record = asRecord(value);
  if (!record) {
    return '';
  }

  const direct = [record.text, record.content, record.message, record.delta]
    .map((item) => (typeof item === 'string' ? item : ''))
    .join('');
  if (direct) {
    return direct;
  }

  const nestedKeys = ['content', 'contents', 'message', 'messages', 'update', 'chunk'];
  return nestedKeys.map((key) => collectText(record[key])).filter(Boolean).join('');
}

class JsonRpcAcpTransport extends EventEmitter implements AcpTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 1;
  private initialized = false;
  private suppressEvents = false;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    method: string;
  }>();
  private readonly promptRequests = new Map<JsonRpcId, string>();
  private readonly sessionModels = new Map<string, string>();
  private readonly modeModels = new Map<string, string>();

  constructor(private readonly command: string) {
    super();
    this.seedModeModels();
    // Don't spawn here — spawn lazily on first initialize() to avoid orphans
  }

  private seedModeModels(): void {
    // ACP's session/set_mode response is empty {} per spec (SetSessionModeResponse only has _meta).
    // ACP spec defines configOptions and current_mode_update notification for tracking mode/model
    // changes, but Kiro does not implement these yet. As a workaround, we read the model from
    // ~/.kiro/agents/<mode>.json at startup. This is reliable because Kiro's mode IDs map 1:1
    // to these agent config files, and the model field in each file is what Kiro actually uses.
    // TODO: Switch to configOptions / current_mode_update when Kiro implements them.
    const agentsDir = join(homedir(), '.kiro', 'agents');
    for (const mode of ['senior', 'architect']) {
      try {
        const raw = readFileSync(join(agentsDir, `${mode}.json`), 'utf-8');
        const model = JSON.parse(raw)?.model;
        if (typeof model === 'string') this.modeModels.set(mode, model);
      } catch { /* agent config not found, will learn from session/new */ }
    }
  }

  async initialize(): Promise<void> {
    log.debug('transport initialize-begin', {
      hasChild: Boolean(this.child),
      pid: this.child?.pid ?? null,
      initialized: this.initialized,
    });

    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      this.child = this.spawnChild();
      this.initialized = false;
    }

    if (this.initialized) {
      log.debug('transport initialize-skip (already initialized)', { pid: this.child?.pid ?? null });
      return;
    }

    await this.sendRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
      clientInfo: {
        name: 'chatops-ai-agent',
        version: '0.1.0',
      },
    });

    this.initialized = true;
    log.debug('transport initialize-done', { pid: this.child?.pid ?? null });
  }

  async createSession(agent: AgentName = 'senior-agent'): Promise<string> {
    await this.initialize();
    const modeId = agent === 'architect-agent' ? 'architect' : 'senior';

    const result = await this.sendRequest('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });

    const rec = asRecord(result);
    const sessionId = asString(rec?.sessionId);
    if (!sessionId) {
      throw new Error(`ACP session/new did not return sessionId: ${JSON.stringify(result)}`);
    }

    const modes = asRecord(rec?.modes);
    const models = asRecord(rec?.models);
    const currentMode = asString(modes?.currentModeId);
    log.info('session created details', {
      sessionId,
      currentMode,
      currentModel: asString(models?.currentModelId),
    });

    const model = asString(models?.currentModelId);
    if (model) this.sessionModels.set(sessionId, model);
    if (currentMode && model) this.modeModels.set(currentMode, model);

    // ACP spec has no agentName param in session/new.
    // Always use session/set_mode to ensure the correct mode.
    if (currentMode !== modeId) {
      log.info('session/set_mode after create', { sessionId, from: currentMode, to: modeId });
      await this.switchAgent(sessionId, agent);
    }

    this.emitAcpEvent({ sessionId, type: 'started' });
    return sessionId;
  }

  async loadSession(sessionId: string): Promise<string> {
    await this.initialize();

    log.debug('session/load request', { sessionId });
    this.suppressEvents = true;
    const result = await this.sendRequest('session/load', {
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.suppressEvents = false;

    const loadedSessionId = asString(asRecord(result)?.sessionId) ?? sessionId;
    log.debug('session/load response', {
      requestedSessionId: sessionId,
      loadedSessionId,
      resultKeys: Object.keys(asRecord(result) ?? {}),
    });
    const loadedRec = asRecord(result);
    const loadedModels = asRecord(loadedRec?.models);
    const loadedModel = asString(loadedModels?.currentModelId);
    if (loadedModel) this.sessionModels.set(loadedSessionId, loadedModel);
    this.emitAcpEvent({ sessionId: loadedSessionId, type: 'started' });
    return loadedSessionId;
  }

  async switchAgent(sessionId: string, agent: AgentName): Promise<void> {
    await this.initialize();
    const modeId = agent === 'architect-agent' ? 'architect' : 'senior';
    log.info('switchAgent', { sessionId, agent, modeId });
    try {
      await this.sendRequest('session/set_mode', { sessionId, modeId });
      log.info('switchAgent success via session/set_mode', { sessionId, agent });
      this.sessionModels.delete(sessionId);
      const learned = this.modeModels.get(modeId);
      if (learned) this.sessionModels.set(sessionId, learned);
    } catch (err) {
      log.warn('session/set_mode failed, trying command fallback', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.sendRequest('_kiro.dev/commands/execute', {
        sessionId,
        command: `/agent swap ${agent}`,
      });
      log.info('switchAgent success via command fallback', { sessionId, agent });
    }
  }

  getSessionModel(sessionId: string): string | undefined {
    return this.sessionModels.get(sessionId);
  }

  getModeModel(modeId: string): string | undefined {
    return this.modeModels.get(modeId);
  }

  async prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<void> {
    await this.initialize();

    const id = this.nextId;
    this.promptRequests.set(id, sessionId);
    await this.sendRequest('session/prompt', {
      sessionId,
      prompt,
    });
  }

  onEvent(listener: (event: AcpEvent) => void): void {
    this.on('event', listener);
  }

  private spawnChild() {
    log.debug('spawn-start', { command: this.command });
    const child = spawn('sh', ['-lc', this.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    log.debug('spawn-created', { pid: child.pid ?? null });

    child.on('spawn', () => {
      log.debug('spawn-ready', { pid: child.pid ?? null });
    });

    child.on('error', (error) => {
      log.error('spawn-error', { pid: child.pid ?? null, message: error.message });
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        log.debug('stdout', trimmed);
        this.handleLine(trimmed);
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        log.warn('acp stderr', text);
      }
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: text,
      });
    });

    child.on('exit', (code, signal) => {
      log.error('process exited', { pid: child.pid ?? null, code, signal });
      const detail = `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(detail));
      }
      this.pending.clear();
      this.promptRequests.clear();
      this.initialized = false;
      this.child = undefined;
      this.emitAcpEvent({ sessionId: 'unknown', type: 'error', error: detail });
    });

    return child;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      log.error('parse-failed', line);
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: `Unable to parse ACP output: ${line}`,
      });
      return;
    }

    log.debug('message-shape', {
      id: message.id,
      method: message.method,
      hasResult: typeof message.result !== 'undefined',
      hasError: Boolean(message.error),
    });

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        log.debug('no-pending-for-id', { id: message.id });
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        log.error('rpc-error', message.error);
        const promptSessionId = this.promptRequests.get(message.id);
        this.promptRequests.delete(message.id);
        if (promptSessionId) {
          this.emitAcpEvent({ sessionId: promptSessionId, type: 'error', error: message.error.message ?? JSON.stringify(message.error) });
        }
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }

      pending.resolve(message.result);
      const promptSessionId = this.promptRequests.get(message.id);
      if (promptSessionId) {
        this.promptRequests.delete(message.id);
        const finalText = collectText(asRecord(message.result)?.content);
        const preserveBuffer = finalText.length === 0;
        log.debug('prompt-result', {
          id: message.id,
          promptSessionId,
          finalTextLength: finalText.length,
          preserveBuffer,
        });
        this.emitAcpEvent({
          sessionId: promptSessionId,
          type: 'final',
          ...(preserveBuffer ? {} : { text: finalText }),
          preserveBuffer,
        });
      } else {
        this.emitPromptResult(message.result);
      }
      return;
    }

    if (message.method === 'session/update' || message.method === 'session/notification') {
      this.emitSessionUpdate(message.params);
      return;
    }

    if (message.method === 'session/request_permission' && message.id != null) {
      const params = asRecord(message.params);
      const toolCall = asRecord(params?.toolCall);
      log.info('auto-approve permission', { id: message.id, tool: asString(toolCall?.title) });
      this.child?.stdin.write(`${JSON.stringify({
        jsonrpc: JSON_RPC_VERSION,
        id: message.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      })}\n`);
      return;
    }

    log.debug('unhandled-message', line);
  }

  private emitPromptResult(result: unknown): void {
    const record = asRecord(result);
    const sessionId = asString(record?.sessionId);
    const text = collectText(record?.content);

    if (sessionId) {
      this.emitAcpEvent({ sessionId, type: 'final', text });
    }
  }

  private emitSessionUpdate(params: unknown): void {
    if (this.suppressEvents) return;
    const root = asRecord(params);
    const sessionId = asString(root?.sessionId) ?? 'unknown';
    const update = asRecord(root?.update);
    if (!update) {
      log.debug('session-update missing update field', { sessionId, rootKeys: Object.keys(root ?? {}) });
      return;
    }

    const updateType = asString(update.sessionUpdate) ?? asString(update.type) ?? asString(update.kind);
    const content = update.content;
    const text = collectText(content) || collectText(update);
    log.debug('session-update', {
      sessionId,
      updateType,
      textLength: text.length,
    });

    if (
      updateType === 'agent_message_chunk' ||
      updateType === 'agent_thought_chunk' ||
      updateType === 'user_message_chunk' ||
      updateType === 'AgentMessageChunk'
    ) {
      if (text) {
        this.emitAcpEvent({ sessionId, type: 'delta', text });
      }
      return;
    }

    if (updateType === 'tool_call' || updateType === 'ToolCall') {
      const toolName = asString(update.title) ?? asString(update.name) ?? '';
      log.debug('tool_call', { sessionId, tool: toolName });
      this.emitAcpEvent({ sessionId, type: 'tool', toolName });
      return;
    }

    if (
      updateType === 'current_mode_update' ||
      updateType === 'available_commands_update' ||
      updateType === 'config_option_update' ||
      updateType === 'TurnEnd'
    ) {
      return;
    }

    if (text) {
      this.emitAcpEvent({ sessionId, type: 'delta', text });
    }
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params,
    };

    log.debug('sendRequest', { id, method, pid: this.child?.pid ?? null });

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const sessionId = this.promptRequests.get(id) ?? 'unknown';
        this.promptRequests.delete(id);
        const error = new Error(`ACP request timed out: ${method}`);
        this.emitAcpEvent({ sessionId, type: 'error', error: error.message });
        reject(error);
      }, ACP_REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout, method });
      const child = this.child;
      if (!child) {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.promptRequests.delete(id);
        reject(new Error('ACP process is not available'));
        return;
      }

      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          this.promptRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    log.info('transport close', { pid: child?.pid ?? null });

    if (!child || child.killed || child.exitCode !== null) {
      return;
    }

    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
    }

    // Force-kill after 3s if still alive
    setTimeout(() => {
      try { process.kill(-child.pid!, 0); } catch { return; } // already dead
      log.warn('force-killing ACP process', { pid: child.pid });
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }, 3000).unref();
  }

  private emitAcpEvent(event: AcpEvent): void {
    this.emit('event', event);
  }
}

export class AcpProcessManager {
  private readonly sessions = new Map<string, string>();
  private readonly sessionPromises = new Map<string, Promise<string>>();
  private suppressEvents = false;
  private transport: AcpTransport;
  private readonly listeners = new Set<(event: AcpEvent) => void>();
  private readonly command: string;

  constructor(options: AcpManagerOptions = {}) {
    this.command = options.command ?? process.env.ACP_COMMAND ?? 'kiro-cli acp';

    if (options.transport) {
      this.transport = options.transport;
      this.transport.onEvent((event) => this.emit(event));
    } else {
      const transport = new JsonRpcAcpTransport(this.command);
      transport.onEvent((event) => this.emit(event));
      this.transport = transport;
    }
  }

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

  async ensureSession(sessionKey: string, existingSessionId?: string, agent?: AgentName): Promise<EnsureSessionResult> {
    const inMemory = this.sessions.get(sessionKey);
    if (inMemory && (!existingSessionId || inMemory === existingSessionId)) {
      return { sessionId: inMemory, resumed: true, fallbackFromLoad: false };
    }

    const inflight = this.sessionPromises.get(sessionKey);
    if (inflight) {
      const sessionId = await inflight;
      return { sessionId, resumed: Boolean(existingSessionId), fallbackFromLoad: false };
    }

    let fallbackFromLoad = false;
    let resumed = false;

    const ensurePromise = (async () => {
      if (existingSessionId) {
        const loadStartedAt = Date.now();
        log.info('session load-attempt', { sessionKey, existingSessionId, agent });
        try {
          this.suppressEvents = true;
          const restoredSessionId = await Promise.race<string>([
            this.transport.loadSession(existingSessionId),
            new Promise<string>((_, reject) => {
              setTimeout(() => reject(new Error(`ACP session/load timed out after ${ACP_LOAD_TIMEOUT_MS}ms`)), ACP_LOAD_TIMEOUT_MS);
            }),
          ]);
          this.suppressEvents = false;
          log.info('session load-success', {
            sessionKey,
            restoredSessionId,
            reusedSameId: restoredSessionId === existingSessionId,
            elapsedMs: Date.now() - loadStartedAt,
          });
          this.sessions.set(sessionKey, restoredSessionId);
          resumed = true;
          return restoredSessionId;
        } catch (error) {
          this.suppressEvents = false;
          fallbackFromLoad = true;
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.warn('session load-failed, falling back to new session', {
            sessionKey,
            existingSessionId,
            error: errorMessage,
            elapsedMs: Date.now() - loadStartedAt,
          });
          this.recycleTransport(`load-failed:${errorMessage}`);
        }
      }

      log.info('session create', { sessionKey, agent });
      const sessionId = await this.transport.createSession(agent);
      log.info('session created', { sessionKey, sessionId });
      this.sessions.set(sessionKey, sessionId);
      return sessionId;
    })().finally(() => {
      this.sessionPromises.delete(sessionKey);
    });

    this.sessionPromises.set(sessionKey, ensurePromise);
    const sessionId = await ensurePromise;
    return { sessionId, resumed, fallbackFromLoad };
  }

  async switchAgent(sessionId: string, agent: AgentName): Promise<void> {
    await this.transport.switchAgent(sessionId, agent);
  }

  getSessionModel(sessionId: string): string | undefined {
    return this.transport.getSessionModel(sessionId);
  }

  getModeModel(modeId: string): string | undefined {
    return this.transport.getModeModel(modeId);
  }

  getSessionIdByKey(sessionKey: string): string | undefined {
    return this.sessions.get(sessionKey);
  }

  async sendPrompt(payload: AcpPromptPayload): Promise<void> {
    const sessionKey = `THREAD#${payload.metadata.channelId}:${payload.metadata.threadTs}`;
    this.sessions.set(sessionKey, payload.sessionId);
    await this.transport.prompt(payload.sessionId, payload.prompt);
  }

  close(): void {
    this.transport.close();
  }

  private recycleTransport(reason: string): void {
    log.warn('recycling transport', { reason });
    this.transport.close();
    const transport = new JsonRpcAcpTransport(this.command);
    transport.onEvent((event) => this.emit(event));
    this.transport = transport;
  }

  private emit(event: AcpEvent): void {
    if (this.suppressEvents) return;
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
