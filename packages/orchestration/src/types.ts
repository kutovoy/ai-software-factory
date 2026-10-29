/**
 * Workflow-safe types. Nothing in this file may import Node APIs or Temporal worker
 * packages: it is bundled into the deterministic workflow sandbox.
 */

export type RunStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';
export type TerminalStatus = 'ok' | 'error' | 'cancelled';
export type HarnessId =
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'generic-cli'
  | 'fake';

export type RunnerKindName = 'local-docker' | 'local-process' | 'fake';

export interface RunPrompt {
  text: string;
  files?: string[];
}

/** Everything a run needs, resolved and pinned by the API before the workflow starts. */
export interface RunInput {
  runId: string;
  /** Factory name as declared in `factory.yaml`. */
  factory: string;
  /** Absolute path of the definition directory on the worker host. */
  factoryRoot: string;
  /** Pinned git commit of the definition (ADR-003). */
  definitionCommit: string;
  definitionDirty: boolean;
  harness: HarnessId;
  model?: string;
  agent?: string;
  runner: RunnerKindName;
  repo?: { path?: string; url?: string; commit?: string };
  /** First human message. Chat and factory runs share this field (ADR-002). */
  prompt: RunPrompt | null;
  kind: 'chat' | 'run';
  title?: string;
  /** Models this run may call through the inference proxy. Empty/absent → no proxy. */
  proxyModels: string[];
  /** Scripted adapter step delay; lets tests kill the worker mid-run. */
  fakeDelayMs?: number;
  workspace?: string;
  /** Setup commands from the definition's runner resource (executed inside the sandbox). */
  setupCommands?: string[];
}

export interface LeaseInfo {
  runnerId: string;
  kind: 'docker' | 'local';
  workspace: string;
  harnessUrl?: string;
  /** True when the run uses the in-process scripted adapter (no sandbox process). */
  ephemeral: boolean;
}

export interface ProxyCredentials {
  token: string;
  tokenId: string;
  baseUrl: string;
  models: string[];
}

export interface HarnessStartInfo {
  sessionRef?: string;
  harnessUrl?: string;
  /** Serialised capabilities, so the API can degrade without knowing the adapter. */
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    permissions: 'interactive' | 'static' | 'none';
    resume: boolean;
    fork: boolean;
    usage: boolean;
    structuredOutput: boolean;
  };
  /** True when the session was recreated after a worker restart. */
  resumed: boolean;
}

export interface PumpResult {
  /** Status reported by the adapter's terminal event, if it emitted one. */
  terminalStatus: TerminalStatus | null;
  /** Summary carried by the adapter's terminal event. */
  terminalSummary?: string;
  /** Last `seq` persisted by this attempt. */
  lastSeq: number;
  /** Number of events appended in this attempt. */
  appended: number;
  /** Number of adapter payloads dropped (unmappable). */
  droppedEvents: number;
}

export interface RunArtifact {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'patch' | 'log' | 'screenshot' | 'file';
}

export interface RunOutcome {
  runId: string;
  status: TerminalStatus;
  lastSeq: number;
  summary?: string;
}

export interface PersistEventInput {
  runId: string;
  /** Idempotency key; the same stepId never writes twice. */
  stepId: string;
  /** Event produced by an adapter (already has `seq`/`at`). */
  event?: unknown;
}

export interface AppendTerminalInput {
  runId: string;
  stepId: string;
  status: TerminalStatus;
  summary?: string;
}

export interface AppendTerminalResult {
  appended: boolean;
  seq: number | null;
}

export interface StepRecord {
  runId: string;
  stepId: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  detail?: unknown;
  error?: string;
}
