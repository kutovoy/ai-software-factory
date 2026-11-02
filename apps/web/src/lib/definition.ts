import type { ResourceSummary } from './types';

/**
 * Typed, read-only views over the resource documents projected by
 * `GET /factories/:factoryId/resources`. The console never edits a definition (ADR-012),
 * so these helpers only read: no defaults invented, no values guessed.
 */

/** Display order for the resource tree; unknown kinds sort last. */
export const RESOURCE_KIND_ORDER = [
  'agent',
  'agent-skill',
  'automation',
  'scorer',
  'benchmark',
  'benchmark-task',
  'runner',
  'routing',
  'skill',
  'packs',
] as const;

export const RESOURCE_KIND_LABELS: Record<string, string> = {
  agent: 'Agents',
  'agent-skill': 'Agent skills',
  automation: 'Automations',
  scorer: 'Scorers',
  benchmark: 'Benchmarks',
  'benchmark-task': 'Benchmark tasks',
  runner: 'Runners',
  routing: 'Routing',
  skill: 'Skills',
  packs: 'Packs',
};

/** Gate stages in the order the resolver knows them. */
export const GATE_STAGES = ['spec', 'plan', 'implement', 'review', 'pr_review', 'deploy'] as const;

export interface ResourceGroup {
  kind: string;
  label: string;
  resources: ResourceSummary[];
}

export function groupResources(resources: ResourceSummary[]): ResourceGroup[] {
  const byKind = new Map<string, ResourceSummary[]>();
  for (const resource of resources) {
    const bucket = byKind.get(resource.kind);
    if (bucket) bucket.push(resource);
    else byKind.set(resource.kind, [resource]);
  }

  const known = RESOURCE_KIND_ORDER as readonly string[];
  const extra = [...byKind.keys()].filter((kind) => !known.includes(kind)).sort();
  return [...known, ...extra]
    .filter((kind) => byKind.has(kind))
    .map((kind) => ({
      kind,
      label: RESOURCE_KIND_LABELS[kind] ?? kind,
      resources: byKind.get(kind) ?? [],
    }));
}

/* --------------------------------------------------------------- documents */

export interface HarnessDoc {
  type?: string;
  model?: string;
  reasoningLevel?: string;
  auth?: { source?: string; secretName?: string };
}

export interface InferenceDoc {
  harness?: HarnessDoc;
  model?: string;
}

export interface AgentDoc extends InferenceDoc {
  description?: string;
  role?: string;
  runner?: string;
  tools?: { allow?: string[]; deny?: string[] };
  secrets?: string[];
  /** MCP servers this agent may use (spec `mcp-integration`). */
  mcp?: string[];
  /** @deprecated Legacy allow list; prefer `mcp`. */
  mcpServers?: string[];
  spawnableBy?: string[];
  idleTimeoutMinutes?: number;
}

export interface TriggerDoc {
  provider?: string;
  event?: string;
  schedule?: string;
  filter?: Record<string, unknown>;
}

export interface AutomationDoc extends InferenceDoc {
  displayName?: string;
  enabled?: boolean;
  agent?: string;
  runner?: string;
  triggers?: TriggerDoc[];
  secrets?: string[];
  mcpServers?: string[];
  gates?: Record<string, string>;
}

export interface ScorerLabelDoc {
  value?: string;
  score?: number;
  description?: string;
}

export interface ScorerDoc {
  description?: string;
  output?: string;
  labels?: ScorerLabelDoc[];
  passingScore?: number;
  samplingRate?: number;
  judgeModel?: string;
  agents?: string[];
  selfImprovement?: boolean;
  runner?: string;
  secrets?: string[];
}

export interface BenchmarkConfigurationDoc {
  name?: string;
  agents?: { agent?: string; harness?: HarnessDoc; model?: string }[];
}

export interface BenchmarkDoc {
  name?: string;
  description?: string;
  agent?: string;
  configurations?: BenchmarkConfigurationDoc[];
  tasks?: string[];
}

export interface BenchmarkTaskDoc {
  title?: string;
  prompt?: string;
  successCriteria?: string;
  startingRepoRefs?: string[];
  tags?: string[];
}

export interface RunnerDoc {
  description?: string;
  setupCommands?: string[];
  instanceShape?: { vcpus?: number; memoryGb?: number };
  platform?: { os?: string; arch?: string; linux?: { dockerImage?: string } };
  failureSessionRetentionMinutes?: number;
}

export function docOf<T>(resource: ResourceSummary): T {
  return (resource.doc ?? {}) as T;
}

/** Resolved inference selection: agent override, else factory defaults. */
export function inference(
  doc: InferenceDoc,
  defaults?: InferenceDoc | null,
): { harness: string | null; model: string | null; auth: HarnessDoc['auth'] | null } {
  const harness = doc.harness ?? defaults?.harness;
  return {
    harness: harness?.type ?? null,
    model: doc.model ?? doc.harness?.model ?? defaults?.model ?? defaults?.harness?.model ?? null,
    auth: doc.harness?.auth ?? null,
  };
}

/** One line per trigger: provider + event/schedule + a compact filter summary. */
export function describeTrigger(trigger: TriggerDoc): string {
  const provider = trigger.provider ?? 'unknown';
  const when = trigger.schedule ? `schedule ${trigger.schedule}` : (trigger.event ?? 'event');
  const filter = trigger.filter && Object.keys(trigger.filter).length > 0 ? ` ${JSON.stringify(trigger.filter)}` : '';
  return `${provider}: ${when}${filter}`;
}

export function describeValue(value: unknown): string {
  if (value === undefined) return '(none)';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return '(none)';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** "4m ago" style ages are elsewhere; this is only for definition metadata. */
export function gateMeaning(gate: string): string {
  if (gate === 'human') return 'waits for a human';
  if (gate === 'agent') return 'unattended';
  return `policy ${gate.slice('policy:'.length)}`;
}
