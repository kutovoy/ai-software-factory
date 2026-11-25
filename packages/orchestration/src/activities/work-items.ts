import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_QUALITY_STANDARDS,
  DEFAULT_SLOP_BUDGETS,
  PROOF_KINDS,
  appendWorkItemEvent,
  attachPullRequest,
  evaluateSlopBudget,
  evaluateStandards,
  getAutonomyState,
  getWorkItem,
  getWorkItemCancel,
  highRiskPathsTouched,
  listWorkItemEvents,
  markWorkItemCancelled,
  parsePatchMetrics,
  recordGateDecision,
  requestGateDecision,
  setWorkItemStatus,
  transitionWorkItem,
  type AgentVerdict,
  type AutonomyState,
  type GateDecisionValue,
  type LoopStage,
  type PatchMetrics,
  type ProofKind,
  type QualityStandards,
  type ReviewPacket,
  type RiskTier,
  type SlopBudget,
  type StandardsStatus,
  type WorkItemCancelState,
  type WorkItemEvent,
  type WorkItemStatus,
} from '@factory/core';
import { loadConfig } from '../config';
import { getRun, getSql } from '../db';
import { artifactsDir, patchPath } from '../run-dir';

/**
 * Work item persistence activities.
 *
 * All reads/writes go through `@factory/core`'s repository with the worker's SQL handle;
 * the workflow never touches Postgres (deterministic sandbox). Activities are idempotent
 * (guarded transitions, pending-only gate writes, unchanged-PR no-ops), so Temporal
 * retries are free.
 */

export async function recordStageTransition(args: {
  workItemId: string;
  from: LoopStage;
  to: LoopStage;
  by: string;
  actor?: string | null;
  reason?: string | null;
  loopCountDelta?: number;
}): Promise<void> {
  await transitionWorkItem(getSql(), args);
}

export async function recordGateRequest(args: {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  gate: string;
  workflowId: string;
  slaAt?: string | null;
}): Promise<void> {
  await requestGateDecision(getSql(), args);
}

export async function resolveGateDecision(args: {
  workItemId: string;
  stage: LoopStage;
  attempt: number;
  decision: GateDecisionValue;
  actor: string;
  reason?: string | null;
  feedback?: string | null;
  verdict?: AgentVerdict | null;
  automatic?: boolean;
}): Promise<void> {
  await recordGateDecision(getSql(), args);
}

export async function attachWorkItemPullRequest(args: {
  workItemId: string;
  prUrl: string;
  prNumber?: number | null;
}): Promise<void> {
  await attachPullRequest(getSql(), args);
}

export async function setWorkItemStatusActivity(args: {
  workItemId: string;
  status: WorkItemStatus;
  actor?: string;
  reason?: string | null;
}): Promise<void> {
  await setWorkItemStatus(getSql(), args);
}

export async function recordWorkItemEvent(args: {
  workItemId: string;
  type: string;
  stage?: string | null;
  actor?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await appendWorkItemEvent(getSql(), args);
}

export function emptyAutonomyState(factory: string): AutonomyState {
  return {
    factory,
    enabled: false,
    paused: false,
    actor: null,
    reason: null,
    overrideActor: null,
    overrideReason: null,
    benchmarkGateRequired: false,
    updatedAt: null,
  };
}

/** Read-model autonomy snapshot (kill switch + lights-off policy). */
export async function readAutonomyState(args: { factory: string }): Promise<AutonomyState> {
  return (await getAutonomyState(getSql(), args.factory)) ?? emptyAutonomyState(args.factory);
}

/** Recorded cancellation request, checked before every dispatch (task 1.3). */
export async function readWorkItemCancel(args: {
  workItemId: string;
}): Promise<WorkItemCancelState> {
  return await getWorkItemCancel(getSql(), args.workItemId);
}

/** Terminal cancellation write: `cancelled` + exactly one `work_item.cancelled` event. */
export async function cancelWorkItem(args: {
  workItemId: string;
  stage?: string | null;
  actor?: string | null;
  reason?: string | null;
}): Promise<void> {
  await markWorkItemCancelled(getSql(), args);
}

/* ------------------------------------------------------------ review packet */

/** The fixed checklist shown with every deterministic review packet. */
export const REVIEWER_CHECKLIST = [
  'Intent matches the approved plan and the vertical slice.',
  'The diff stays inside the intended scope; no unrelated files changed.',
  'Every required assertion passed with concrete evidence.',
  'No architecture boundary, dependency-cycle or public-API regression.',
  'No new duplication, dead code or unjustified dependency.',
  'Open questions are answered or explicitly accepted by the reviewer.',
];

export interface DiffStats {
  changedFiles: number;
  additions: number;
  deletions: number;
}

/**
 * Counts changed files and +/- lines from a unified diff. Delegates to the core
 * `parsePatchMetrics` parser (change `add-anti-slop-budgets-and-proof`) so the packet and
 * the slop budget read the same deterministic numbers. Missing input is all zeroes.
 */
export function parsePatchStats(patch: string): DiffStats {
  const metrics = parsePatchMetrics(patch);
  return {
    changedFiles: metrics.changedFiles,
    additions: metrics.additions,
    deletions: metrics.deletions,
  };
}

export interface PacketAssertion {
  id: string;
  status: string;
  evidence: string;
}

/**
 * Reads the newest `validation.evidence` event and maps its `checks` into packet
 * assertions. Malformed entries are ignored; no event means no assertions.
 */
export function assertionsFromWorkItemEvents(events: WorkItemEvent[]): PacketAssertion[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'validation.evidence') continue;
    const checks = event.payload?.checks;
    if (!Array.isArray(checks)) continue;
    const assertions: PacketAssertion[] = [];
    for (const entry of checks) {
      if (typeof entry !== 'object' || entry === null) continue;
      const check = entry as Record<string, unknown>;
      const id =
        typeof check.checkId === 'string'
          ? check.checkId
          : typeof check.id === 'string'
            ? check.id
            : null;
      const status = typeof check.status === 'string' ? check.status : null;
      if (!id || !status) continue;
      const evidence =
        typeof check.detail === 'string'
          ? check.detail
          : typeof check.evidence === 'string'
            ? check.evidence
            : '';
      assertions.push({ id, status, evidence });
    }
    return assertions;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isProofKindName(value: unknown): value is ProofKind {
  return typeof value === 'string' && (PROOF_KINDS as readonly string[]).includes(value);
}

/** Merges a stored budget with the tier default; a missing field inherits the default. */
function parseSlopBudget(value: unknown, fallback: SlopBudget): SlopBudget {
  const record = asRecord(value);
  return {
    maxDiffLines: asNumber(record.maxDiffLines, fallback.maxDiffLines),
    maxChangedFiles: asNumber(record.maxChangedFiles, fallback.maxChangedFiles),
    maxNewDependencies: asNumber(record.maxNewDependencies, fallback.maxNewDependencies),
    maxDuplicationDeltaPercent: asNumber(
      record.maxDuplicationDeltaPercent,
      fallback.maxDuplicationDeltaPercent,
    ),
    maxComplexityDelta: asNumber(record.maxComplexityDelta, fallback.maxComplexityDelta),
  };
}

/* ------------------------------------------------------- packet v2 helpers */

/** Duplication/complexity reported by the newest `validation.evidence` event, else null. */
export function slopMetricsFromEvents(events: WorkItemEvent[]): {
  duplicationDeltaPercent: number | null;
  complexityDelta: number | null;
} {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'validation.evidence') continue;
    const checks = event.payload?.checks;
    if (!Array.isArray(checks)) continue;
    let duplication: number | null = null;
    let complexity: number | null = null;
    for (const entry of checks) {
      if (typeof entry !== 'object' || entry === null) continue;
      const metrics = (entry as Record<string, unknown>).metrics;
      if (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics)) continue;
      const record = metrics as Record<string, unknown>;
      const pick = (...keys: string[]): number | null => {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === 'number' && Number.isFinite(value)) return value;
        }
        return null;
      };
      duplication = duplication ?? pick('duplicationDeltaPercent', 'maxDuplicationPercent');
      complexity = complexity ?? pick('complexityDelta', 'maxComplexity');
    }
    return { duplicationDeltaPercent: duplication, complexityDelta: complexity };
  }
  return { duplicationDeltaPercent: null, complexityDelta: null };
}

/** Maps a patch artifact path/name to the proof kind it represents. */
export function classifyProofArtifact(nameOrPath: string): ProofKind {
  const path = typeof nameOrPath === 'string' ? nameOrPath.toLowerCase() : '';
  const base = path.split('/').pop() ?? path;
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/.test(base)) return 'screenshot';
  if (/\.(mp4|webm|mov|m4v|avi)$/.test(base)) return 'video';
  if (/\.(html?|htm)$/.test(base)) return 'html';
  if (base.includes('curl') || /\.(curl|har)$/.test(base)) return 'curl';
  if (/(report|junit|results?|test-?report)/.test(base) || /\.(json|xml|log|txt|md)$/.test(base)) {
    return 'report';
  }
  return 'file';
}

function looksPublicApi(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes('openapi') ||
    /(^|\/)api\//.test(lower) ||
    /(^|\/)api\.(ts|js|py|go|rs|java)$/.test(lower)
  );
}

function looksSchema(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('schema') || lower.includes('migration');
}

function looksUi(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    /(^|\/)(app|pages|components)\//.test(lower) ||
    /\.(tsx|jsx|css|scss|html|vue|svelte)$/.test(lower)
  );
}

/** Blast radius from measured files and the governance high-risk globs. */
export function blastRadiusFor(
  metrics: PatchMetrics,
  highRiskPatterns: string[],
): ReviewPacket['blastRadius'] {
  const paths = metrics.files.map((file) => file.path);
  return {
    paths,
    highRiskPaths: highRiskPathsTouched(paths, highRiskPatterns),
    publicApiChanges: paths.filter(looksPublicApi).length,
    schemaChanges: paths.filter(looksSchema).length,
  };
}

/**
 * Standards status for a measured blast radius (change
 * `add-risk-aware-routing-and-standards`). Deterministic and exported so the packet, the
 * event and the gate all read the same numbers.
 */
export function standardsFor(
  blastRadius: ReviewPacket['blastRadius'],
  config: QualityStandards,
): StandardsStatus {
  return evaluateStandards(
    {
      publicApiChanges: blastRadius.publicApiChanges,
      schemaChanges: blastRadius.schemaChanges,
    },
    config,
  );
}

/**
 * Defensive parse of a stored `standards` payload (old packets have none). Caps fall back to
 * the resolved config; counts fall back to zero. A missing/unknown status is re-derived from
 * the counts so an old packet never claims a pass it did not measure.
 */
export function parseStandards(
  value: unknown,
  fallback: QualityStandards,
): StandardsStatus {
  const record = asRecord(value);
  const maxPublicApiChanges = asNumber(record.maxPublicApiChanges, fallback.maxPublicApiChanges);
  const maxSchemaChanges = asNumber(record.maxSchemaChanges, fallback.maxSchemaChanges);
  const publicApiChanges = asNumber(record.publicApiChanges);
  const schemaChanges = asNumber(record.schemaChanges);
  const status: StandardsStatus['status'] =
    record.status === 'pass' || record.status === 'exceeded'
      ? record.status
      : publicApiChanges > maxPublicApiChanges || schemaChanges > maxSchemaChanges
        ? 'exceeded'
        : 'pass';
  return {
    maxPublicApiChanges,
    maxSchemaChanges,
    publicApiChanges,
    schemaChanges,
    status,
  };
}


/** Ordered files a reviewer should open first: high-risk first, then the largest change. */export function buildReadFirst(
  files: PatchMetrics['files'],
  highRiskPaths: string[],
): Array<{ path: string; why: string }> {
  const risky = new Set(highRiskPaths);
  return [...files]
    .sort((left, right) => {
      const leftRisk = risky.has(left.path) ? 1 : 0;
      const rightRisk = risky.has(right.path) ? 1 : 0;
      if (leftRisk !== rightRisk) return rightRisk - leftRisk;
      if (left.additions !== right.additions) return right.additions - left.additions;
      return left.path.localeCompare(right.path);
    })
    .slice(0, 5)
    .map((file) => {
      const why: string[] = [];
      if (risky.has(file.path)) why.push('high-risk path');
      if (looksPublicApi(file.path) || looksSchema(file.path)) {
        why.push('touches public API/schema');
      }
      if (why.length === 0) {
        why.push(file.additions + file.deletions > 0 ? 'largest change' : 'changed file');
      }
      return { path: file.path, why: why.join('; ') };
    });
}

/** Reviewer roles implied by the change: correctness always, then the extra lenses. */
export function reviewerRolesFor(args: {
  architectureImpact?: string[];
  highRiskPaths?: string[];
  paths?: string[];
}): string[] {
  const roles = ['correctness'];
  if ((args.architectureImpact ?? []).length > 0) roles.push('architecture');
  if ((args.highRiskPaths ?? []).length > 0) roles.push('security');
  if ((args.paths ?? []).some(looksUi)) roles.push('product');
  return roles;
}

/** Honest comprehension estimates; `modulesWithoutOwner` is not computed (unknown = 0). */
export function comprehensionFor(
  files: PatchMetrics['files'],
  diffLines: number,
): ReviewPacket['comprehension'] {
  return {
    estimatedReadMinutes: Math.max(1, Math.ceil(diffLines / 200)),
    filesWithoutTests: files.filter(
      (file) => !/(test|spec|__tests__|e2e)/i.test(file.path),
    ).length,
    modulesWithoutOwner: 0,
  };
}

/** Budget-vs-actual projection stored on the packet. */
export function slopActualFor(
  metrics: PatchMetrics,
  delta: { duplicationDeltaPercent: number | null; complexityDelta: number | null },
): ReviewPacket['slopActual'] {
  return {
    changedFiles: metrics.changedFiles,
    additions: metrics.additions,
    deletions: metrics.deletions,
    diffLines: metrics.diffLines,
    newDependencies: metrics.newDependencies,
    duplicationDeltaPercent: delta.duplicationDeltaPercent,
    complexityDelta: delta.complexityDelta,
  };
}

/** Gate decisions and review verdicts from the newest 50 events, newest first (max 10). */
export function decisionsFromEvents(
  events: WorkItemEvent[],
  limit = 10,
): ReviewPacket['decisions'] {
  const recent = events.slice(-50);
  const decisions: ReviewPacket['decisions'] = [];
  for (let index = recent.length - 1; index >= 0 && decisions.length < limit; index -= 1) {
    const event = recent[index];
    if (!event) continue;
    const payload = asRecord(event.payload);
    if (event.type === 'gate.decided') {
      const decision = typeof payload.decision === 'string' ? payload.decision : '';
      if (decision.length === 0) continue;
      decisions.push({
        at: event.createdAt ?? '',
        actor:
          typeof payload.actor === 'string' && payload.actor.length > 0
            ? payload.actor
            : (event.actor ?? ''),
        decision,
        reason:
          typeof payload.reason === 'string'
            ? payload.reason
            : typeof payload.feedback === 'string'
              ? payload.feedback
              : '',
        ref: `gate:${event.stage ?? 'unknown'}:${
          typeof payload.attempt === 'number' ? payload.attempt : 0
        }`,
      });
    } else if (event.type === 'review.verdict') {
      const decision = typeof payload.verdict === 'string' ? payload.verdict : '';
      if (decision.length === 0) continue;
      const findings = Array.isArray(payload.findings) ? payload.findings : [];
      const summaries = findings
        .map((finding) => asRecord(finding).summary)
        .filter((summary): summary is string => typeof summary === 'string')
        .slice(0, 2);
      decisions.push({
        at: event.createdAt ?? '',
        actor: event.actor ?? '',
        decision,
        reason: summaries.join('; ').slice(0, 300),
        ref: `review:${event.stage ?? 'unknown'}:${
          typeof payload.reviewer === 'string' ? payload.reviewer : 'committee'
        }`,
      });
    }
  }
  return decisions;
}

/** Local files under `runs/<id>/artifacts`, recursively, deterministic order. */
async function localArtifactFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await localArtifactFiles(full, depth + 1)));
    } else if (entry.isFile()) {
      files.push(full);
    }
    if (files.length >= 64) break;
  }
  return files;
}

/**
 * Proof artifacts for a run: the run row's artifact metadata plus files in
 * `runs/<id>/artifacts`. Local files get a sha256; every record is bound to the commit.
 * Missing run rows / directories yield an empty list, never a failure.
 */
export async function proofArtifactsFor(
  patchRunId: string | null,
  definitionCommit?: string,
): Promise<ReviewPacket['proofArtifacts']> {
  if (!patchRunId) return [];
  const artifacts: ReviewPacket['proofArtifacts'] = [];
  const seen = new Set<string>();
  const commit = definitionCommit;

  try {
    const run = await getRun(patchRunId);
    const rows = Array.isArray(run?.artifacts) ? run.artifacts : [];
    for (const row of rows) {
      const record = asRecord(row);
      const path = typeof record.path === 'string' ? record.path : null;
      if (!path) continue;
      const key = path.replace(/^artifacts\//, '');
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({
        kind: classifyProofArtifact(path),
        path,
        label: path.split('/').pop() ?? path,
        ...(commit ? { commit } : {}),
        ...(typeof record.sha256 === 'string' && record.sha256.length > 0
          ? { hash: record.sha256 }
          : {}),
      });
      if (artifacts.length >= 20) return artifacts;
    }
  } catch {
    // No DB / run row: fall through to the local directory.
  }

  const root = artifactsDir(loadConfig().runsDir, patchRunId);
  for (const full of await localArtifactFiles(root)) {
    const name = full.slice(root.length + 1).replaceAll('\\', '/');
    if (seen.has(name)) continue;
    seen.add(name);
    let hash: string | undefined;
    try {
      hash = createHash('sha256').update(await readFile(full)).digest('hex');
    } catch {
      hash = undefined;
    }
    artifacts.push({
      kind: classifyProofArtifact(name),
      path: `artifacts/${name}`,
      label: name.split('/').pop() ?? name,
      ...(commit ? { commit } : {}),
      ...(hash ? { hash } : {}),
    });
    if (artifacts.length >= 20) break;
  }
  return artifacts;
}

function packetFromPayload(
  payload: Record<string, unknown>,
  fallback: {
    riskTier: RiskTier;
    intent: string;
    slopBudget: SlopBudget;
    standards: QualityStandards;
  },
): ReviewPacket {
  const diffStats = asRecord(payload.diffStats);
  const changedFiles = asNumber(payload.changedFiles);
  const additions = asNumber(diffStats.additions);
  const deletions = asNumber(diffStats.deletions);
  const storedActual = asRecord(payload.slopActual);
  const blastRadius = asRecord(payload.blastRadius);
  const comprehension = asRecord(payload.comprehension);
  return {
    riskTier:
      payload.riskTier === 'low' || payload.riskTier === 'medium' || payload.riskTier === 'high'
        ? payload.riskTier
        : fallback.riskTier,
    intent: typeof payload.intent === 'string' ? payload.intent : fallback.intent,
    planRef: typeof payload.planRef === 'string' ? payload.planRef : null,
    changedFiles,
    diffStats: { additions, deletions },
    assertions: Array.isArray(payload.assertions)
      ? payload.assertions
          .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            id: typeof entry.id === 'string' ? entry.id : '',
            status: typeof entry.status === 'string' ? entry.status : '',
            evidence: typeof entry.evidence === 'string' ? entry.evidence : '',
          }))
          .filter((entry) => entry.id.length > 0)
      : [],
    architectureImpact: asStringArray(payload.architectureImpact),
    openQuestions: asStringArray(payload.openQuestions),
    reviewerChecklist: Array.isArray(payload.reviewerChecklist)
      ? asStringArray(payload.reviewerChecklist)
      : [...REVIEWER_CHECKLIST],
    slopBudget: parseSlopBudget(payload.slopBudget, fallback.slopBudget),
    slopActual: {
      changedFiles: asNumber(storedActual.changedFiles, changedFiles),
      additions: asNumber(storedActual.additions, additions),
      deletions: asNumber(storedActual.deletions, deletions),
      diffLines: asNumber(storedActual.diffLines, additions + deletions),
      newDependencies: asNumber(storedActual.newDependencies),
      duplicationDeltaPercent: asNullableNumber(storedActual.duplicationDeltaPercent),
      complexityDelta: asNullableNumber(storedActual.complexityDelta),
    },
    slopStatus:
      payload.slopStatus === 'pass' ||
      payload.slopStatus === 'exceeded' ||
      payload.slopStatus === 'unknown'
        ? payload.slopStatus
        : 'unknown',
    blastRadius: {
      paths: asStringArray(blastRadius.paths),
      highRiskPaths: asStringArray(blastRadius.highRiskPaths),
      publicApiChanges: asNumber(blastRadius.publicApiChanges),
      schemaChanges: asNumber(blastRadius.schemaChanges),
    },
    standards: parseStandards(payload.standards, fallback.standards),
    proofArtifacts: (Array.isArray(payload.proofArtifacts) ? payload.proofArtifacts : [])
      .map(asRecord)
      .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0)
      .map((entry) => ({
        kind: isProofKindName(entry.kind) ? entry.kind : 'file',
        path: entry.path as string,
        label: typeof entry.label === 'string' ? entry.label : '',
        ...(typeof entry.commit === 'string' ? { commit: entry.commit } : {}),
        ...(typeof entry.hash === 'string' ? { hash: entry.hash } : {}),
      })),
    readFirst: (Array.isArray(payload.readFirst) ? payload.readFirst : [])
      .map(asRecord)
      .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0)
      .map((entry) => ({
        path: entry.path as string,
        why: typeof entry.why === 'string' ? entry.why : '',
      })),
    decisions: (Array.isArray(payload.decisions) ? payload.decisions : [])
      .map(asRecord)
      .filter((entry) => typeof entry.decision === 'string' && entry.decision.length > 0)
      .map((entry) => ({
        at: typeof entry.at === 'string' ? entry.at : '',
        actor: typeof entry.actor === 'string' ? entry.actor : '',
        decision: entry.decision as string,
        reason: typeof entry.reason === 'string' ? entry.reason : '',
        ...(typeof entry.ref === 'string' ? { ref: entry.ref } : {}),
      })),
    reviewerRoles: asStringArray(payload.reviewerRoles),
    comprehension: {
      estimatedReadMinutes: Math.max(
        1,
        asNumber(
          comprehension.estimatedReadMinutes,
          Math.max(1, Math.ceil((additions + deletions) / 200)),
        ),
      ),
      filesWithoutTests: asNumber(comprehension.filesWithoutTests),
      modulesWithoutOwner: asNumber(comprehension.modulesWithoutOwner),
    },
    contextPackRef: typeof payload.contextPackRef === 'string' ? payload.contextPackRef : null,
  };
}

/**
 * Deterministic review packet (change `harden-factory-quality`, task 5.1; extended to v2 by
 * `add-anti-slop-budgets-and-proof`, task 2.1).
 *
 * Assembled from plan metadata, validation evidence, the captured patch and run artifacts —
 * never model prose. Idempotent per (item, stage, attempt): a retried stage returns the
 * existing packet instead of appending duplicate `review.packet` / slop events. A missing
 * patch yields zero metrics and an `unknown` budget status; the activity never fails because
 * the run directory was cleaned or the patch is absent.
 */
export async function recordReviewPacket(args: {
  workItemId: string;
  /** Stage the packet belongs to; used with `attempt` for idempotency. */
  stage?: string;
  /** Stage attempt the packet belongs to. */
  attempt?: number;
  riskTier: RiskTier;
  intent: string;
  planRef?: string | null;
  patchRunId?: string | null;
  architectureImpact?: string[];
  openQuestions?: string[];
  reviewerChecklist?: string[];
  /** Resolved budget for `riskTier`; defaults to the shipped tier budget. */
  slopBudget?: SlopBudget;
  /** Governance high-risk globs used for blast radius and reviewer roles. */
  highRiskPaths?: string[];
  /** Stable context-pack reference; recorded so the UI can link the pack. */
  contextPackRef?: string | null;
  /** Definition commit proof artifacts are bound to. */
  definitionCommit?: string;
  /** Resolved public-API/schema caps; defaults to the shipped standards. */
  standards?: QualityStandards;
}): Promise<ReviewPacket> {
  const sql = getSql();
  const workItem = await getWorkItem(sql, args.workItemId);
  if (!workItem) throw new Error(`work item ${args.workItemId} does not exist`);

  const events = await listWorkItemEvents(sql, args.workItemId, 1000);
  const budget = args.slopBudget ?? DEFAULT_SLOP_BUDGETS[args.riskTier];
  const standardsConfig = args.standards ?? DEFAULT_QUALITY_STANDARDS;
  const existing = events.find(
    (event) =>
      event.type === 'review.packet' &&
      (args.stage === undefined || event.stage === args.stage) &&
      (args.attempt === undefined || event.payload?.attempt === args.attempt),
  );
  if (existing) {
    return packetFromPayload(existing.payload, {
      riskTier: args.riskTier,
      intent: args.intent,
      slopBudget: budget,
      standards: standardsConfig,
    });
  }

  let metrics: PatchMetrics = parsePatchMetrics('');
  let patchExists = false;
  if (args.patchRunId) {
    try {
      const patch = await readFile(patchPath(loadConfig().runsDir, args.patchRunId), 'utf8');
      if (typeof patch === 'string' && patch.trim().length > 0) {
        metrics = parsePatchMetrics(patch);
        patchExists = true;
      }
    } catch {
      // Missing/cleaned run directory: the packet still describes the evidence and plan.
    }
  }

  const deltas = slopMetricsFromEvents(events);
  const slopActual = slopActualFor(metrics, deltas);
  const evaluation = evaluateSlopBudget(slopActual, budget);
  const blastRadius = blastRadiusFor(metrics, args.highRiskPaths ?? []);
  const standards = standardsFor(blastRadius, standardsConfig);
  const proofArtifacts = await proofArtifactsFor(args.patchRunId ?? null, args.definitionCommit);
  const readFirst = buildReadFirst(metrics.files, blastRadius.highRiskPaths);
  const decisions = decisionsFromEvents(events);
  const reviewerRoles = reviewerRolesFor({
    architectureImpact: args.architectureImpact ?? [],
    highRiskPaths: blastRadius.highRiskPaths,
    paths: blastRadius.paths,
  });
  const comprehension = comprehensionFor(metrics.files, metrics.diffLines);

  const packet: ReviewPacket = {
    riskTier: args.riskTier,
    intent: args.intent,
    planRef: args.planRef ?? null,
    changedFiles: metrics.changedFiles,
    diffStats: { additions: metrics.additions, deletions: metrics.deletions },
    assertions: assertionsFromWorkItemEvents(events),
    architectureImpact: args.architectureImpact ?? [],
    openQuestions: args.openQuestions ?? [],
    reviewerChecklist: args.reviewerChecklist ?? [...REVIEWER_CHECKLIST],
    slopBudget: budget,
    slopActual,
    slopStatus: evaluation.status,
    blastRadius,
    standards,
    proofArtifacts,
    readFirst,
    decisions,
    reviewerRoles,
    comprehension,
    contextPackRef: args.contextPackRef ?? null,
  };

  const stage = args.stage ?? workItem.stage;

  // Deterministic slop measurement (task 1.3). Only a real patch produces metrics; the
  // events are written before the packet so the audit trail keeps its causal order.
  if (patchExists) {
    await appendWorkItemEvent(sql, {
      workItemId: args.workItemId,
      type: 'slop.measured',
      stage,
      actor: 'foreman',
      payload: {
        metrics: slopActual,
        budget,
        status: evaluation.status,
        overages: evaluation.overages,
        ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
      },
    });
    if (evaluation.status === 'exceeded') {
      await appendWorkItemEvent(sql, {
        workItemId: args.workItemId,
        type: 'slop.budget_exceeded',
        stage,
        actor: 'foreman',
        payload: {
          metrics: slopActual,
          budget,
          overages: evaluation.overages,
          riskTier: args.riskTier,
          ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
        },
      });
    }
  }

  // Standards guard (change `add-risk-aware-routing-and-standards`): recorded before the
  // packet so the audit trail keeps its causal order. Idempotent because an existing packet
  // returns above without appending anything.
  if (standards.status === 'exceeded') {
    await appendWorkItemEvent(sql, {
      workItemId: args.workItemId,
      type: 'standards.exceeded',
      stage,
      actor: 'foreman',
      payload: {
        standards,
        riskTier: args.riskTier,
        ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
      },
    });
  }

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'review.packet',
    stage,
    actor: 'foreman',
    payload: {
      ...packet,
      ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
    },
  });

  return packet;
}

/**
 * Optional model-written review explainer (task 2.3): an executive summary and/or an HTML
 * page. Clearly separate from the deterministic packet — facts never come from this event.
 * Bounded and idempotent per (item, stage, attempt).
 */
export async function recordReviewExplainer(args: {
  workItemId: string;
  summary: string;
  html?: string;
  stage?: string;
  attempt?: number;
}): Promise<{ recorded: boolean }> {
  const sql = getSql();
  const workItem = await getWorkItem(sql, args.workItemId);
  if (!workItem) throw new Error(`work item ${args.workItemId} does not exist`);

  const stage = args.stage ?? workItem.stage;
  const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 4000) : '';
  if (summary.length === 0) return { recorded: false };

  const events = await listWorkItemEvents(sql, args.workItemId, 1000);
  const existing = events.find(
    (event) =>
      event.type === 'review.explainer' &&
      event.stage === stage &&
      (args.attempt === undefined || event.payload?.attempt === args.attempt),
  );
  if (existing) return { recorded: false };

  await appendWorkItemEvent(sql, {
    workItemId: args.workItemId,
    type: 'review.explainer',
    stage,
    actor: 'foreman',
    payload: {
      summary,
      ...(typeof args.html === 'string' && args.html.trim().length > 0
        ? { html: args.html.slice(0, 20_000) }
        : {}),
      ...(args.attempt !== undefined ? { attempt: args.attempt } : {}),
    },
  });
  return { recorded: true };
}
