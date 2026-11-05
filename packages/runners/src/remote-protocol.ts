import type {
  HarnessAgentDefinition,
  PromptPart,
  UsageReport,
} from '@factory/adapters';
import type {
  Artifact,
  ArtifactRequest,
  ExecEvent,
  ExecRequest,
  RunnerHandle,
  RunnerSpec,
} from './protocol';

/**
 * Wire protocol between the central control plane and a remote runner agent.
 *
 * The agent is an executor, not a Temporal worker and not a Postgres client. It enrolls
 * once, then polls an outbound command queue and posts results back. Every command is
 * keyed by `runnerId`/`runId`, so a retry re-attaches instead of starting a second
 * sandbox. The agent runs the harness adapter locally: canonical events travel back to
 * the central worker, which remains the single writer of the event log.
 */

export type RunnerHostPlatform = 'linux' | 'windows' | 'macos';

/**
 * Maps the enrolled platform to the Node `process.platform` value, so host probes (shell
 * selection, metrics, sandbox availability) agree with what the control plane recorded.
 */
export function toNodePlatform(platform: RunnerHostPlatform): NodeJS.Platform {
  if (platform === 'windows') return 'win32';
  if (platform === 'macos') return 'darwin';
  return 'linux';
}

export type RunnerHostStatus =
  | 'pending'
  | 'provisioning'
  | 'initializing'
  | 'ready'
  | 'not_ready'
  | 'unreachable'
  | 'maintenance'
  | 'deleting'
  | 'error';

export interface RunnerDiskMetrics {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  inodeUsedPercent?: number;
}

/** Host health sample. No secrets, no prompts, no provider credentials. */
export interface RunnerMetrics {
  capturedAt: string;
  cpuPercent: number;
  load1: number;
  load5: number;
  load15: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryAvailableBytes: number;
  memoryUsedPercent: number;
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  disks: RunnerDiskMetrics[];
  uptimeSeconds?: number;
  processCount?: number;
  agentVersion: string;
  leases?: number;
  queueWaitMs?: number;
}

export interface RunnerEnrollmentRequest {
  token: string;
  name: string;
  platform: RunnerHostPlatform;
  arch: string;
  pool?: string;
  labels?: Record<string, string>;
  maxConcurrent?: number;
  agentVersion?: string;
  hostname?: string;
}

export interface RunnerEnrollmentResponse {
  hostId: string;
  agentToken: string;
  heartbeatIntervalMs: number;
  commandPollTimeoutMs: number;
}

export interface RunnerPreflightCheck {
  ok: boolean;
  detail?: string;
}

export interface RunnerPreflightRequest {
  platform: RunnerHostPlatform;
  checks: Record<string, RunnerPreflightCheck>;
}

export interface RunnerHeartbeatRequest {
  metrics: RunnerMetrics;
  status?: RunnerHostStatus;
  leases?: number;
}

export type RunnerCommandType =
  | 'lease'
  | 'exec'
  | 'start-session'
  | 'pump'
  | 'respond-permission'
  | 'artifacts'
  | 'kill'
  | 'cancel'
  | 'smoke-test';

export interface RunnerCommandEnvelope {
  id: string;
  hostId: string;
  type: RunnerCommandType;
  payload: unknown;
  createdAt: string;
}

export interface RunnerCommandError {
  code: string;
  message: string;
  details?: unknown;
}

export interface RunnerCommandResultEnvelope {
  commandId: string;
  ok: boolean;
  result?: unknown;
  error?: RunnerCommandError;
}

/** Payload for `start-session`: everything the agent needs to run one harness session. */
export interface RemoteRunStartPayload {
  runId: string;
  runnerId: string;
  harness: string;
  model?: string;
  /** The spec already used by the `lease` command; re-leasing is idempotent. */
  leaseSpec?: RunnerSpec;
  repo?: {
    url?: string;
    path?: string;
    commit?: string;
    /** Unified diff content; the agent writes it to a temp file before checkout. */
    patchContent?: string;
  };
  harnessCommand: string;
  harnessEnv?: Record<string, string>;
  harnessPort: number;
  readyPath: string;
  readyTimeoutMs: number;
  secrets?: { name: string }[];
  networkPolicy?: 'allowed' | 'denied';
  promptParts: PromptPart[];
  agents?: HarnessAgentDefinition[];
  mcp?: unknown;
  sessionRef?: string | null;
  fakeDelayMs?: number;
  metadata?: Record<string, unknown>;
  workspace?: string;
  runDir?: string;
}

export interface RemoteRunStartResult {
  runnerId: string;
  harnessUrl?: string;
  sessionRef?: string;
  capabilities?: unknown;
  mcp?: unknown;
}

export interface RemotePumpPayload {
  runId: string;
  fromSeq?: number;
  decided?: Record<string, 'allow' | 'deny' | 'always'>;
  /** How long the agent may wait for the next event before returning `idle`. */
  waitMs?: number;
}

export interface RemotePumpResult {
  events: unknown[];
  stopReason: 'permission' | 'terminal' | 'cancelled' | 'closed' | 'idle';
  terminalStatus?: 'ok' | 'error' | 'cancelled' | null;
  terminalSummary?: string;
  lastSeq: number;
  costUsd?: number;
  permissionRequestId?: string;
  permissionAction?: string;
  droppedEvents?: number;
}

export interface RemoteArtifactResult {
  artifacts: Artifact[];
  /** `patch.diff` content, written centrally into the run directory. */
  patch?: string;
  usage?: UsageReport | null;
  /**
   * Artifacts that could not be uploaded to object storage. The metadata and patch are
   * still returned; the central collect step records these errors (ADR-047).
   */
  uploadErrors?: string[];
}

/** One artifact the agent wants a presigned upload grant for. */
export interface RemoteArtifactUploadRequest {
  path: string;
  bytes: number;
  sha256: string;
  kind: Artifact['kind'];
  contentType?: string;
}

/** Body of `POST /api/v1/runner-agent/artifacts/presign`. */
export interface RemotePresignRequest {
  runnerId: string;
  runId: string;
  artifacts: RemoteArtifactUploadRequest[];
}

/** A run-scoped presigned PUT grant. */
export interface RemoteArtifactUploadGrant {
  path: string;
  key: string;
  url: string;
  /** Signed headers the uploader must send (e.g. `content-type`). */
  headers?: Record<string, string>;
  bucket?: string;
}

/** Response of the presign route; `uploads: []` means storage is disabled. */
export interface RemotePresignResponse {
  uploads: RemoteArtifactUploadGrant[];
}

export interface RemoteSmokeResult {
  ok: boolean;
  checks: Record<string, RunnerPreflightCheck>;
}

export interface RemoteLeaseResult extends RunnerHandle {}

export interface RemoteExecResult {
  events: ExecEvent[];
}

export type RemoteCommandPayload =
  | { type: 'lease'; spec: RunnerSpec }
  | { type: 'exec'; runnerId: string; request: ExecRequest }
  | { type: 'start-session'; request: RemoteRunStartPayload }
  | { type: 'pump'; request: RemotePumpPayload }
  | { type: 'respond-permission'; runId: string; requestId: string; decision: 'allow' | 'deny' | 'always' }
  | { type: 'artifacts'; runnerId: string; request: ArtifactRequest }
  | { type: 'kill'; runnerId: string }
  | { type: 'cancel'; runId: string; reason?: string }
  | { type: 'smoke-test' };

/**
 * Central-side command transport. The orchestration layer implements this over Postgres;
 * tests can implement it in memory. The remote backend never needs to know how commands
 * reach the agent.
 */
export interface RemoteCommandTransport {
  enqueue(input: {
    hostId: string;
    type: RunnerCommandType;
    payload: unknown;
    timeoutMs?: number;
  }): Promise<{ commandId: string }>;
  wait(commandId: string, timeoutMs: number): Promise<RunnerCommandResultEnvelope>;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_COMMAND_POLL_TIMEOUT_MS = 25_000;
