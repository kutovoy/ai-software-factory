/** Wire shapes returned by `apps/api`. Kept structural: no shared runtime types. */

export type RunStatus = 'pending' | 'running' | 'ok' | 'error' | 'cancelled';

export interface RunSummary {
  id: string;
  factory: string;
  definitionCommit: string;
  definitionDirty: boolean;
  harness: string;
  model: string | null;
  runner: string;
  kind: string;
  title: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RunStep {
  step_id: string;
  kind: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  detail: unknown;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface RunArtifact {
  path: string;
  bytes?: number;
  kind?: string;
  sha256?: string;
}

export interface PermissionRow {
  request_id: string;
  action: string;
  detail: unknown;
  decision: 'allow' | 'deny' | 'always' | null;
  requested_at: string;
  decided_at: string | null;
}

export interface RunRow {
  id: string;
  factory: string;
  definition_commit: string;
  definition_dirty: boolean;
  harness: string;
  model: string | null;
  runner: string;
  kind: string;
  title: string | null;
  input: unknown;
  status: RunStatus;
  workflow_id: string;
  temporal_run_id: string | null;
  session_ref: string | null;
  error: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  cost_usd: string | number | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  artifacts: unknown;
}

export interface RunDetail {
  /** Raw row (snake_case) as returned by the API. */
  run: RunRow;
  /** Camel-cased projection — prefer this for display fields. */
  summary: RunSummary;
  steps: RunStep[];
  artifacts: RunArtifact[] | null;
  permissions: PermissionRow[];
  pendingPermissions: PermissionRow[];
  proxyAttempts: unknown[];
}

export interface GateStage {
  stage: string;
  gate: string;
  source: 'automation' | 'factory' | 'global';
}

export interface GateResolution {
  stages: Record<string, GateStage>;
  mergePolicy: string;
  fullyAutonomous: boolean;
  benchmarkGateRequired: boolean;
}

export interface FactoryVersionSummary {
  commit: string;
  shortCommit: string;
  tag: string | null;
  contentHash: string | null;
  dirty: boolean | null;
}

export interface FactoryListItem {
  name: string;
  manifestName: string | null;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  valid: boolean;
  errorCount: number;
  version: FactoryVersionSummary | null;
}

export interface FactoryManifest {
  schemaVersion: string;
  name: string;
  alias?: string;
  description?: string;
  repositories: { owner: string; name: string }[];
  agentDefaults: {
    harness?: { type: string; model: string };
    model?: string;
    runner?: string;
  };
  gates: Record<string, string>;
  mergePolicy: string;
  secrets: string[];
  mcpServers?: Record<string, unknown>;
  integrations?: string[];
  selfImprovement?: {
    enabled: boolean;
    failedRunThreshold: number;
    reviewerType: string;
    requireBenchmarkWin: boolean;
  };
}

export interface FactoryDetail {
  name: string;
  manifest: FactoryManifest;
  manifestName: string;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  version: FactoryVersionSummary | null;
  gates: GateResolution;
  fullyAutonomous: boolean;
  benchmarkGateRequired: boolean;
}

export interface ResourceSummary {
  kind: string;
  name: string;
  path: string;
  format: 'yaml' | 'markdown';
  summary: string;
  /** Normalised document as declared in git (schema defaults applied). */
  doc: unknown;
}

export interface FactoryResources {
  factory: string;
  counts: Record<string, number>;
  resources: ResourceSummary[];
}

export interface FactoryVersionEntry {
  commit: string;
  shortCommit: string;
  tag: string | null;
  date: string | null;
  message: string;
}

export interface DefinitionDiff {
  added: { kind: string; name: string }[];
  removed: { kind: string; name: string }[];
  changed: { kind: string; name: string; changes: { pointer: string; old: unknown; new: unknown }[] }[];
  isEmpty: boolean;
}

export interface FactoryDiff {
  factory: string;
  from: { commit: string | null; tag: string | null };
  to: { commit: string; tag: string | null };
  diff: DefinitionDiff;
  text: string;
}
