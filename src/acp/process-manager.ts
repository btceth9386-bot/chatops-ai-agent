import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AcpEvent, AcpPromptPayload, AgentName } from '../types';

const JSON_RPC_VERSION = '2.0';
const ACP_PROTOCOL_VERSION = 1;
const ACP_REQUEST_TIMEOUT_MS = 60_000;
const ACP_LOAD_TIMEOUT_MS = 30_000;

type JsonRpcId = number;

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
  prompt(sessionId: string, prompt: Array<{ type: 'text'; text: string }>): Promise<void>;
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

  constructor(private readonly command: string) {
    super();
    this.child = this.spawnChild();
  }

  async initialize(): Promise<void> {
    console.error('[DIAG][ACP transport] initialize-begin', JSON.stringify({
      hasChild: Boolean(this.child),
      pid: this.child?.pid ?? null,
      exitCode: this.child?.exitCode ?? null,
      killed: this.child?.killed ?? null,
      initialized: this.initialized,
    }));

    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      this.child = this.spawnChild();
      this.initialized = false;
    }

    if (this.initialized) {
      console.error('[DIAG][ACP transport] initialize-skip-already-initialized', JSON.stringify({
        pid: this.child?.pid ?? null,
      }));
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
    console.error('[DIAG][ACP transport] initialize-done', JSON.stringify({
      pid: this.child?.pid ?? null,
      initialized: this.initialized,
    }));
  }

  async createSession(agent: AgentName = 'senior-agent'): Promise<string> {
    await this.initialize();

    const result = await this.sendRequest('session/new', {
      cwd: process.cwd(),
      agentName: agent,
      mcpServers: [],
    });

    const sessionId = asString(asRecord(result)?.sessionId);
    if (!sessionId) {
      throw new Error(`ACP session/new did not return sessionId: ${JSON.stringify(result)}`);
    }

    this.emitAcpEvent({ sessionId, type: 'started' });
    return sessionId;
  }

  async loadSession(sessionId: string): Promise<string> {
    await this.initialize();

    console.error('[DIAG][ACP transport] session/load request', JSON.stringify({
      sessionId,
      cwd: process.cwd(),
    }));
    this.suppressEvents = true;
    const result = await this.sendRequest('session/load', {
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.suppressEvents = false;

    const loadedSessionId = asString(asRecord(result)?.sessionId) ?? sessionId;
    console.error('[DIAG][ACP transport] session/load response', JSON.stringify({
      requestedSessionId: sessionId,
      loadedSessionId,
      resultKeys: Object.keys(asRecord(result) ?? {}),
    }));
    this.emitAcpEvent({ sessionId: loadedSessionId, type: 'started' });
    return loadedSessionId;
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
    console.error('[DIAG][ACP transport] spawn-start', JSON.stringify({ command: this.command }));
    const child = spawn('sh', ['-lc', this.command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.error('[DIAG][ACP transport] spawn-created', JSON.stringify({
      command: this.command,
      pid: child.pid ?? null,
    }));

    child.on('spawn', () => {
      console.error('[DIAG][ACP transport] spawn-ready', JSON.stringify({
        pid: child.pid ?? null,
      }));
    });

    child.on('error', (error) => {
      console.error('[DIAG][ACP transport] spawn-error', JSON.stringify({
        pid: child.pid ?? null,
        message: error.message,
      }));
    });

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        console.error('[DIAG][ACP stdout]', trimmed);
        this.handleLine(trimmed);
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error('[DIAG][ACP stderr]', text);
      }
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: text,
      });
    });

    child.on('exit', (code, signal) => {
      console.error('[DIAG][ACP transport] exit', JSON.stringify({
        pid: child.pid ?? null,
        code: code ?? null,
        signal: signal ?? null,
      }));
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
      console.error('[DIAG][ACP handleLine] parse-failed', line);
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: `Unable to parse ACP output: ${line}`,
      });
      return;
    }

    console.error('[DIAG][ACP handleLine] message-shape', JSON.stringify({
      hasId: typeof message.id === 'number',
      id: message.id,
      method: message.method,
      hasResult: typeof message.result !== 'undefined',
      hasError: Boolean(message.error),
    }));

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        console.error('[DIAG][ACP handleLine] no-pending-for-id', JSON.stringify({ id: message.id }));
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timeout);

      if (message.error) {
        console.error('[DIAG][ACP handleLine] rpc-error', JSON.stringify(message.error));
        this.promptRequests.delete(message.id);
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }

      pending.resolve(message.result);
      const promptSessionId = this.promptRequests.get(message.id);
      if (promptSessionId) {
        this.promptRequests.delete(message.id);
        const finalText = collectText(asRecord(message.result)?.content);
        const preserveBuffer = finalText.length === 0;
        console.error('[DIAG][ACP handleLine] prompt-result', JSON.stringify({
          id: message.id,
          promptSessionId,
          finalTextLength: finalText.length,
          resultKeys: Object.keys(asRecord(message.result) ?? {}),
          preserveBuffer,
        }));
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

    console.error('[DIAG][ACP handleLine] unhandled-message', line);
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
      console.error('[DIAG][ACP emitSessionUpdate] missing-update', JSON.stringify({ sessionId, rootKeys: Object.keys(root ?? {}) }));
      return;
    }

    const updateType = asString(update.sessionUpdate) ?? asString(update.type) ?? asString(update.kind);
    const content = update.content;
    const text = collectText(content) || collectText(update);
    console.error('[DIAG][ACP emitSessionUpdate]', JSON.stringify({
      sessionId,
      updateType,
      textLength: text.length,
      updateKeys: Object.keys(update),
    }));

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
      const toolName = asString(update.name) ?? 'tool';
      this.emitAcpEvent({ sessionId, type: 'delta', text: `\n[tool:${toolName}]\n` });
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

    console.error('[DIAG][ACP transport] sendRequest', JSON.stringify({
      id,
      method,
      hasChild: Boolean(this.child),
      pid: this.child?.pid ?? null,
      exitCode: this.child?.exitCode ?? null,
      killed: this.child?.killed ?? null,
    }));

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
    console.error('[DIAG][ACP transport] close-called', JSON.stringify({
      hasChild: Boolean(child),
      pid: child?.pid ?? null,
      exitCode: child?.exitCode ?? null,
      killed: child?.killed ?? null,
    }));

    if (!child || child.killed || child.exitCode !== null) {
      this.child = undefined;
      this.initialized = false;
      return;
    }

    try {
      console.error('[DIAG][ACP transport] close-sigterm-process-group', JSON.stringify({ pid: child.pid ?? null }));
      process.kill(-child.pid!, 'SIGTERM');
    } catch (error) {
      console.error('[DIAG][ACP transport] close-process-group-failed', JSON.stringify({
        pid: child.pid ?? null,
        error: error instanceof Error ? error.message : String(error),
      }));
      child.kill('SIGTERM');
    }

    this.child = undefined;
    this.initialized = false;
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
        console.error('[DIAG][ACP ensureSession] load-attempt', JSON.stringify({
          sessionKey,
          existingSessionId,
          agent,
          timeoutMs: ACP_LOAD_TIMEOUT_MS,
        }));
        try {
          this.suppressEvents = true;
          const restoredSessionId = await Promise.race<string>([
            this.transport.loadSession(existingSessionId),
            new Promise<string>((_, reject) => {
              setTimeout(() => reject(new Error(`ACP session/load timed out after ${ACP_LOAD_TIMEOUT_MS}ms`)), ACP_LOAD_TIMEOUT_MS);
            }),
          ]);
          this.suppressEvents = false;
          console.error('[DIAG][ACP ensureSession] load-success', JSON.stringify({
            sessionKey,
            existingSessionId,
            restoredSessionId,
            reusedSameId: restoredSessionId === existingSessionId,
            elapsedMs: Date.now() - loadStartedAt,
          }));
          this.sessions.set(sessionKey, restoredSessionId);
          resumed = true;
          return restoredSessionId;
        } catch (error) {
          this.suppressEvents = false;
          fallbackFromLoad = true;
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error('[DIAG][ACP ensureSession] load-failed', JSON.stringify({
            sessionKey,
            existingSessionId,
            error: errorMessage,
            elapsedMs: Date.now() - loadStartedAt,
          }));
          this.recycleTransport(`load-failed:${errorMessage}`);
          console.error('[DIAG][ACP ensureSession] fallback-session-new', JSON.stringify({
            sessionKey,
            priorSessionId: existingSessionId,
            agent,
          }));
        }
      }

      console.error('[DIAG][ACP ensureSession] create-session', JSON.stringify({
        sessionKey,
        agent,
        hadExistingSessionId: Boolean(existingSessionId),
      }));
      const sessionId = await this.transport.createSession(agent);
      console.error('[DIAG][ACP ensureSession] create-session-success', JSON.stringify({
        sessionKey,
        sessionId,
        agent,
      }));
      this.sessions.set(sessionKey, sessionId);
      return sessionId;
    })().finally(() => {
      this.sessionPromises.delete(sessionKey);
    });

    this.sessionPromises.set(sessionKey, ensurePromise);
    const sessionId = await ensurePromise;
    return { sessionId, resumed, fallbackFromLoad };
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
    console.error('[DIAG][ACP manager] recycle-transport', JSON.stringify({ reason }));
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
