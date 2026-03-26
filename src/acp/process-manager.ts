import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { AcpEvent, AcpPromptPayload, AgentName } from '../types';

const JSON_RPC_VERSION = '2.0';
const ACP_PROTOCOL_VERSION = 1;

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
  prompt(sessionId: string, content: Array<{ type: 'text'; text: string }>): Promise<void>;
  onEvent(listener: (event: AcpEvent) => void): void;
}

export interface AcpManagerOptions {
  transport?: AcpTransport;
  command?: string;
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
  private readonly child;
  private buffer = '';
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly promptRequests = new Map<JsonRpcId, string>();

  constructor(command: string) {
    super();
    this.child = spawn('sh', ['-lc', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleLine(trimmed);
      }
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: chunk.toString().trim(),
      });
    });

    this.child.on('exit', (code, signal) => {
      const detail = `ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(detail));
      }
      this.pending.clear();
      this.promptRequests.clear();
      this.emitAcpEvent({ sessionId: 'unknown', type: 'error', error: detail });
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
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

  async prompt(sessionId: string, content: Array<{ type: 'text'; text: string }>): Promise<void> {
    await this.initialize();

    const id = this.nextId;
    this.promptRequests.set(id, sessionId);
    await this.sendRequest('session/prompt', {
      sessionId,
      content,
    });
  }

  onEvent(listener: (event: AcpEvent) => void): void {
    this.on('event', listener);
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emitAcpEvent({
        sessionId: 'unknown',
        type: 'error',
        error: `Unable to parse ACP output: ${line}`,
      });
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        this.promptRequests.delete(message.id);
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }

      pending.resolve(message.result);
      const promptSessionId = this.promptRequests.get(message.id);
      if (promptSessionId) {
        this.promptRequests.delete(message.id);
        this.emitAcpEvent({
          sessionId: promptSessionId,
          type: 'final',
          text: collectText(asRecord(message.result)?.content),
        });
      } else {
        this.emitPromptResult(message.result);
      }
      return;
    }

    if (message.method === 'session/update' || message.method === 'session/notification') {
      this.emitSessionUpdate(message.params);
    }
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
    const root = asRecord(params);
    const sessionId = asString(root?.sessionId) ?? 'unknown';
    const update = asRecord(root?.update);
    if (!update) {
      return;
    }

    const updateType = asString(update.sessionUpdate) ?? asString(update.type) ?? asString(update.kind);
    const content = update.content;
    const text = collectText(content) || collectText(update);

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

    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          this.promptRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  private emitAcpEvent(event: AcpEvent): void {
    this.emit('event', event);
  }
}

export class AcpProcessManager {
  private readonly sessions = new Map<string, string>();
  private readonly sessionPromises = new Map<string, Promise<string>>();
  private readonly transport: AcpTransport;
  private readonly listeners = new Set<(event: AcpEvent) => void>();

  constructor(options: AcpManagerOptions = {}) {
    if (options.transport) {
      this.transport = options.transport;
      this.transport.onEvent((event) => this.emit(event));
    } else {
      const command = options.command ?? process.env.ACP_COMMAND ?? 'kiro-cli acp';
      const transport = new JsonRpcAcpTransport(command);
      transport.onEvent((event) => this.emit(event));
      this.transport = transport;
    }
  }

  onEvent(listener: (event: AcpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensureSession(sessionKey: string, existingSessionId?: string, agent?: AgentName): Promise<string> {
    const current = existingSessionId ?? this.sessions.get(sessionKey);
    if (current) {
      this.sessions.set(sessionKey, current);
      return current;
    }

    const inflight = this.sessionPromises.get(sessionKey);
    if (inflight) {
      return await inflight;
    }

    const createdPromise = this.transport.createSession(agent).then((sessionId) => {
      this.sessions.set(sessionKey, sessionId);
      this.sessionPromises.delete(sessionKey);
      return sessionId;
    }).catch((error) => {
      this.sessionPromises.delete(sessionKey);
      throw error;
    });

    this.sessionPromises.set(sessionKey, createdPromise);
    return await createdPromise;
  }

  async sendPrompt(payload: AcpPromptPayload): Promise<void> {
    this.sessions.set(`${payload.metadata.channelId}:${payload.metadata.threadTs}`, payload.sessionId);
    await this.transport.prompt(payload.sessionId, payload.content);
  }

  private emit(event: AcpEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
