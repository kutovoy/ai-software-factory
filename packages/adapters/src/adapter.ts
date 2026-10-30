import type { FactoryEvent, JsonValue } from './events';
import type { McpSessionWiring } from './mcp';

export type AdapterId =
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'generic-cli'
  | 'fake';

export type PermissionMode = 'interactive' | 'static' | 'none';

/**
 * Capability negotiation. Consumers degrade gracefully instead of guessing:
 *   - `permissions: "static"` → the API exposes no decision endpoint for the run
 *   - `resume: false`         → a resumed run starts a fresh session and records that
 *   - `structuredOutput: false` → callers must not pass a schema to `sendPrompt`
 */
export interface AdapterCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  permissions: PermissionMode;
  resume: boolean;
  fork: boolean;
  usage: boolean;
  structuredOutput: boolean;
  /**
   * True when the harness can host MCP servers. A harness without it records the requested
   * wiring as capability flags instead of silently dropping it (spec `mcp-integration`).
   */
  mcp: boolean;
}

export interface StartSessionRequest {
  runId: string;
  /** Model identifier in the harness's own format (e.g. `provider/model` for opencode). */
  model?: string;
  /** Harness-native agent/subagent name. */
  agent?: string;
  title?: string;
  /** Workspace directory the harness should operate in (inside the runner sandbox). */
  workspace?: string;
  /** Extra harness-native options; adapters ignore what they do not understand. */
  metadata?: Record<string, JsonValue>;
  /**
   * MCP servers + per-agent permission globs (spec `mcp-integration`). Names only:
   * adapters render credentials as `{env:NAME}` templates and never see values.
   */
  mcp?: McpSessionWiring;
}

export interface SessionHandle {
  adapterId: AdapterId;
  runId: string;
  /** Harness-native session reference (opencode `ses_…`). */
  sessionRef?: string;
  /** Base URL of the harness when it is a server (opencode serve). */
  harnessUrl?: string;
  model?: string;
  meta?: Record<string, JsonValue>;
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string; name?: string; mimeType?: string }
  | { type: 'image'; path: string; name?: string; mimeType?: string }
  | { type: 'resource'; uri: string; mimeType?: string };

export interface PromptOptions {
  agent?: string;
  model?: string;
  /** Only valid when `capabilities.structuredOutput` is true. */
  structuredOutput?: { schema: JsonValue; name?: string };
}

export type PermissionDecision = 'allow' | 'deny' | 'always';

export interface AgentDescriptor {
  id: string;
  name: string;
  mode?: 'primary' | 'subagent' | 'all';
  description?: string;
  model?: string;
  hidden?: boolean;
}

export interface FileDiff {
  path: string;
  diff: string;
  status?: 'added' | 'deleted' | 'modified';
  additions?: number;
  deletions?: number;
}

export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export interface AdapterStats {
  /** Harness payloads with no canonical mapping — dropped, never fatal. */
  droppedEvents: number;
  emittedEvents: number;
}

export interface HarnessAdapter {
  readonly id: AdapterId;
  readonly capabilities: AdapterCapabilities;

  startSession(req: StartSessionRequest): Promise<SessionHandle>;
  sendPrompt(handle: SessionHandle, parts: PromptPart[], opts?: PromptOptions): Promise<void>;
  /**
   * Streams canonical events until the run reaches a terminal state, the signal aborts,
   * or the harness stream closes. Callers should start consuming before `sendPrompt` so
   * no early harness events are missed.
   */
  streamEvents(handle: SessionHandle, signal?: AbortSignal): AsyncIterable<FactoryEvent>;
  cancel(handle: SessionHandle, reason?: string): Promise<void>;
  resume(handle: SessionHandle, sessionRef?: string): Promise<SessionHandle>;
  fork?(handle: SessionHandle, atMessageId?: string): Promise<SessionHandle>;

  respondToPermission(
    handle: SessionHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  listAgents(handle: SessionHandle): Promise<AgentDescriptor[]>;
  getDiff(handle: SessionHandle): Promise<FileDiff[]>;
  getUsage(handle: SessionHandle): Promise<UsageReport>;
  dispose(handle: SessionHandle): Promise<void>;

  /** Optional observability hook (dropped/emitted counters). */
  getStats?(): AdapterStats;
}

export function supportsInteractivePermissions(capabilities: AdapterCapabilities): boolean {
  return capabilities.permissions === 'interactive';
}
