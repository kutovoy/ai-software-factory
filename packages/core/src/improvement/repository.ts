import type { SQL } from 'bun';
import type {
  CanaryRolloutRecord,
  ImprovementEventRecord,
  ImprovementRunRecord,
  LessonFilters,
  LessonRecord,
  ProbeRecord,
  ProposalEditRecord,
  ProposalFilters,
  ProposalRecord,
  ProposalStatus,
} from './types';

/**
 * Improvement repository (ADR-010: plain SQL, explicit `SQL` handle).
 *
 * Idempotency: proposals dedupe on `(improvement_run_id, cluster_key)`, edits on
 * `(proposal_id, kind, path)`, probes on `(proposal_id, edit_id, work_item_id)` and events
 * on `(improvement_run_id, type, subject)`. A Temporal retry never writes a duplicate.
 */

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numOrZero(value: unknown): number {
  return num(value) ?? 0;
}

/* ------------------------------------------------------------- run rows */

interface ImprovementRunRow {
  id: string;
  factory: string;
  definition_commit: string;
  trigger: string;
  status: string;
  authority: string;
  eligibility: unknown;
  proposals: number | string;
  lessons: number | string;
  decision: string | null;
  error: string | null;
  workflow_id: string | null;
  temporal_run_id: string | null;
  started_at: unknown;
  ended_at: unknown;
}

function mapRun(row: ImprovementRunRow): ImprovementRunRecord {
  return {
    id: row.id,
    factory: row.factory,
    definitionCommit: row.definition_commit,
    trigger: row.trigger as ImprovementRunRecord['trigger'],
    status: row.status as ImprovementRunRecord['status'],
    authority: row.authority,
    eligibility: parseJsonb<Record<string, unknown>>(row.eligibility, {}),
    proposals: Number(row.proposals),
    lessons: Number(row.lessons),
    decision: row.decision,
    error: row.error,
    workflowId: row.workflow_id,
    temporalRunId: row.temporal_run_id,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

export interface CreateImprovementRunArgs {
  id: string;
  factory: string;
  definitionCommit: string;
  trigger: ImprovementRunRecord['trigger'];
  authority: string;
  workflowId?: string | null;
  temporalRunId?: string | null;
}

export async function createImprovementRun(
  sql: SQL,
  args: CreateImprovementRunArgs,
): Promise<ImprovementRunRecord> {
  await sql`
    insert into improvement_runs (
      id, factory, definition_commit, trigger, status, authority, workflow_id,
      temporal_run_id, started_at
    ) values (
      ${args.id}, ${args.factory}, ${args.definitionCommit}, ${args.trigger}, 'queued',
      ${args.authority}, ${args.workflowId ?? null}, ${args.temporalRunId ?? null}, now()
    )
    on conflict (id) do nothing
  `;
  const rows = (await sql`
    select * from improvement_runs where id = ${args.id} limit 1
  `) as ImprovementRunRow[];
  return mapRun(rows[0] as ImprovementRunRow);
}

export async function markImprovementRunning(
  sql: SQL,
  args: { id: string; workflowId?: string | null; temporalRunId?: string | null },
): Promise<ImprovementRunRecord> {
  const rows = (await sql`
    update improvement_runs set
      status = case when status = 'queued' then 'running' else status end,
      workflow_id = coalesce(${args.workflowId ?? null}, workflow_id),
      temporal_run_id = coalesce(${args.temporalRunId ?? null}, temporal_run_id),
      started_at = coalesce(started_at, now())
    where id = ${args.id}
    returning *
  `) as ImprovementRunRow[];
  return mapRun(rows[0] as ImprovementRunRow);
}

export async function finishImprovementRun(
  sql: SQL,
  args: {
    id: string;
    status: 'completed' | 'error' | 'skipped';
    eligibility?: Record<string, unknown>;
    proposals?: number;
    lessons?: number;
    decision?: string | null;
    error?: string | null;
  },
): Promise<ImprovementRunRecord> {
  const rows = (await sql`
    update improvement_runs set
      status = ${args.status},
      eligibility = coalesce(${args.eligibility === undefined ? null : JSON.stringify(args.eligibility)}::jsonb, eligibility),
      proposals = ${args.proposals ?? 0},
      lessons = ${args.lessons ?? 0},
      decision = ${args.decision ?? null},
      error = ${args.error ?? null},
      ended_at = coalesce(ended_at, now())
    where id = ${args.id}
    returning *
  `) as ImprovementRunRow[];
  return mapRun(rows[0] as ImprovementRunRow);
}

export async function getImprovementRun(
  sql: SQL,
  id: string,
): Promise<ImprovementRunRecord | null> {
  const rows = (await sql`select * from improvement_runs where id = ${id} limit 1`) as ImprovementRunRow[];
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listImprovementRuns(
  sql: SQL,
  args: { factory?: string | null; limit?: number } = {},
): Promise<ImprovementRunRecord[]> {
  const factory = args.factory ?? null;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const rows = (await sql`
    select * from improvement_runs
    where (${factory}::text is null or factory = ${factory})
    order by started_at desc
    limit ${limit}
  `) as ImprovementRunRow[];
  return rows.map(mapRun);
}

/* -------------------------------------------------------- proposal rows */

interface ProposalRow {
  id: string;
  improvement_run_id: string | null;
  factory: string;
  kind: string;
  authority: string;
  status: string;
  title: string;
  summary: string;
  impact: unknown;
  evidence: unknown;
  failure_signature: string;
  files: unknown;
  diff: unknown;
  candidate_hash: string | null;
  cluster_key: string;
  pr_url: string | null;
  pr_number: number | string | null;
  decision_actor: string | null;
  decision_reason: string | null;
  decided_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function mapProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    improvementRunId: row.improvement_run_id,
    factory: row.factory,
    kind: row.kind as ProposalRecord['kind'],
    authority: row.authority,
    status: row.status as ProposalStatus,
    title: row.title,
    summary: row.summary,
    impact: numOrZero(row.impact),
    evidence: parseJsonb<Record<string, unknown>>(row.evidence, {}),
    failureSignature: row.failure_signature,
    files: parseJsonb<string[]>(row.files, []),
    diff: parseJsonb<ProposalRecord['diff']>(row.diff, []),
    candidateHash: row.candidate_hash,
    prUrl: row.pr_url,
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    decisionActor: row.decision_actor,
    decisionReason: row.decision_reason,
    decidedAt: iso(row.decided_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface CreateProposalArgs {
  id: string;
  improvementRunId?: string | null;
  factory: string;
  kind?: ProposalRecord['kind'];
  authority: string;
  status?: ProposalStatus;
  title: string;
  summary?: string;
  impact: number;
  evidence?: Record<string, unknown>;
  failureSignature?: string;
  files?: string[];
  diff?: ProposalRecord['diff'];
  candidateHash?: string | null;
  clusterKey?: string;
}

export async function createProposal(
  sql: SQL,
  args: CreateProposalArgs,
): Promise<ProposalRecord> {
  const rows = (await sql`
    insert into proposals (
      id, improvement_run_id, factory, kind, authority, status, title, summary, impact,
      evidence, failure_signature, files, diff, candidate_hash, cluster_key
    ) values (
      ${args.id}, ${args.improvementRunId ?? null}, ${args.factory},
      ${args.kind ?? 'improvement'}, ${args.authority}, ${args.status ?? 'open'},
      ${args.title}, ${args.summary ?? ''}, ${args.impact},
      ${JSON.stringify(args.evidence ?? {})}::jsonb, ${args.failureSignature ?? ''},
      ${JSON.stringify(args.files ?? [])}::jsonb, ${JSON.stringify(args.diff ?? [])}::jsonb,
      ${args.candidateHash ?? null}, ${args.clusterKey ?? args.id}
    )
    on conflict (id) do update set
      authority = excluded.authority,
      impact = greatest(proposals.impact, excluded.impact),
      evidence = excluded.evidence,
      files = excluded.files,
      updated_at = now()
    returning *
  `) as ProposalRow[];
  return mapProposal(rows[0] as ProposalRow);
}

export interface UpdateProposalArgs {
  id: string;
  status?: ProposalStatus;
  diff?: ProposalRecord['diff'];
  candidateHash?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  decisionActor?: string | null;
  decisionReason?: string | null;
  decided?: boolean;
}

export async function updateProposal(
  sql: SQL,
  args: UpdateProposalArgs,
): Promise<ProposalRecord> {
  const rows = (await sql`
    update proposals set
      status = coalesce(${args.status ?? null}, status),
      diff = coalesce(${args.diff === undefined ? null : JSON.stringify(args.diff)}::jsonb, diff),
      candidate_hash = coalesce(${args.candidateHash ?? null}, candidate_hash),
      pr_url = coalesce(${args.prUrl ?? null}, pr_url),
      pr_number = coalesce(${args.prNumber ?? null}, pr_number),
      decision_actor = coalesce(${args.decisionActor ?? null}, decision_actor),
      decision_reason = coalesce(${args.decisionReason ?? null}, decision_reason),
      decided_at = case when ${args.decided === true} then now() else decided_at end,
      updated_at = now()
    where id = ${args.id}
    returning *
  `) as ProposalRow[];
  return mapProposal(rows[0] as ProposalRow);
}

export async function getProposal(sql: SQL, id: string): Promise<ProposalRecord | null> {
  const rows = (await sql`select * from proposals where id = ${id} limit 1`) as ProposalRow[];
  return rows[0] ? mapProposal(rows[0]) : null;
}

/** Ranked list: highest impact first, newest first on ties. */
export async function listProposals(
  sql: SQL,
  filters: ProposalFilters = {},
): Promise<ProposalRecord[]> {
  const factory = filters.factory ?? null;
  const status = filters.status ?? null;
  const kind = filters.kind ?? null;
  const runId = filters.improvementRunId ?? null;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = (await sql`
    select * from proposals
    where (${factory}::text is null or factory = ${factory})
      and (${status}::text is null or status = ${status})
      and (${kind}::text is null or kind = ${kind})
      and (${runId}::text is null or improvement_run_id = ${runId})
    order by impact desc, created_at desc
    limit ${limit} offset ${offset}
  `) as ProposalRow[];
  return rows.map(mapProposal);
}

/* ------------------------------------------------------------- edit rows */

interface ProposalEditRow {
  id: string;
  proposal_id: string;
  kind: string;
  path: string;
  rationale: string;
  content: string;
  scope: string;
  rejected: boolean;
  rejection_code: string | null;
  contrast: unknown;
  created_at: unknown;
}

function mapEdit(row: ProposalEditRow): ProposalEditRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    kind: row.kind as ProposalEditRecord['kind'],
    path: row.path,
    rationale: row.rationale,
    content: row.content,
    scope: row.scope as ProposalEditRecord['scope'],
    rejected: row.rejected,
    rejectionCode: row.rejection_code,
    contrast: row.contrast === null ? null : parseJsonb<Record<string, unknown>>(row.contrast, {}),
    createdAt: iso(row.created_at),
  };
}

export interface RecordProposalEditArgs {
  id: string;
  proposalId: string;
  kind: ProposalEditRecord['kind'];
  path: string;
  rationale?: string;
  content: string;
  scope: ProposalEditRecord['scope'];
  rejected?: boolean;
  rejectionCode?: string | null;
  contrast?: Record<string, unknown> | null;
}

export async function recordProposalEdit(
  sql: SQL,
  args: RecordProposalEditArgs,
): Promise<ProposalEditRecord> {
  const rows = (await sql`
    insert into proposal_edits (
      id, proposal_id, kind, path, rationale, content, scope, rejected, rejection_code, contrast
    ) values (
      ${args.id}, ${args.proposalId}, ${args.kind}, ${args.path}, ${args.rationale ?? ''},
      ${args.content}, ${args.scope}, ${args.rejected ?? false}, ${args.rejectionCode ?? null},
      ${args.contrast === undefined || args.contrast === null ? null : JSON.stringify(args.contrast)}::jsonb
    )
    on conflict (proposal_id, kind, path) do update set
      rationale = excluded.rationale,
      content = excluded.content,
      scope = excluded.scope,
      rejected = excluded.rejected,
      rejection_code = excluded.rejection_code,
      contrast = excluded.contrast
    returning *
  `) as ProposalEditRow[];
  return mapEdit(rows[0] as ProposalEditRow);
}

export async function listProposalEdits(
  sql: SQL,
  proposalId: string,
): Promise<ProposalEditRecord[]> {
  const rows = (await sql`
    select * from proposal_edits where proposal_id = ${proposalId} order by kind asc, path asc
  `) as ProposalEditRow[];
  return rows.map(mapEdit);
}

export async function rejectProposalEdit(
  sql: SQL,
  args: { id: string; rejectionCode: string; contrast?: Record<string, unknown> | null },
): Promise<ProposalEditRecord> {
  const rows = (await sql`
    update proposal_edits set
      rejected = true,
      rejection_code = ${args.rejectionCode},
      contrast = coalesce(${args.contrast === undefined || args.contrast === null ? null : JSON.stringify(args.contrast)}::jsonb, contrast)
    where id = ${args.id}
    returning *
  `) as ProposalEditRow[];
  return mapEdit(rows[0] as ProposalEditRow);
}

/* ------------------------------------------------------------- probe rows */

interface ProbeRow {
  id: string;
  proposal_id: string;
  edit_id: string;
  work_item_id: string | null;
  run_id: string | null;
  matched_inputs: unknown;
  baseline_score: unknown;
  candidate_score: unknown;
  delta: unknown;
  winner: boolean;
  created_at: unknown;
}

function mapProbe(row: ProbeRow): ProbeRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    editId: row.edit_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    matchedInputs: parseJsonb<Record<string, unknown>>(row.matched_inputs, {}),
    baselineScore: num(row.baseline_score),
    candidateScore: num(row.candidate_score),
    delta: num(row.delta),
    winner: row.winner,
    createdAt: iso(row.created_at),
  };
}

export interface RecordProbeArgs {
  id: string;
  proposalId: string;
  editId: string;
  workItemId?: string | null;
  runId?: string | null;
  matchedInputs?: Record<string, unknown>;
  baselineScore?: number | null;
  candidateScore?: number | null;
  delta?: number | null;
  winner: boolean;
}

export async function recordProbe(sql: SQL, args: RecordProbeArgs): Promise<ProbeRecord> {
  const rows = (await sql`
    insert into probes (
      id, proposal_id, edit_id, work_item_id, run_id, matched_inputs, baseline_score,
      candidate_score, delta, winner
    ) values (
      ${args.id}, ${args.proposalId}, ${args.editId}, ${args.workItemId ?? null},
      ${args.runId ?? null}, ${JSON.stringify(args.matchedInputs ?? {})}::jsonb,
      ${args.baselineScore ?? null}, ${args.candidateScore ?? null}, ${args.delta ?? null},
      ${args.winner}
    )
    on conflict (proposal_id, edit_id, work_item_id) do update set
      run_id = excluded.run_id,
      matched_inputs = excluded.matched_inputs,
      baseline_score = excluded.baseline_score,
      candidate_score = excluded.candidate_score,
      delta = excluded.delta,
      winner = excluded.winner
    returning *
  `) as ProbeRow[];
  return mapProbe(rows[0] as ProbeRow);
}

export async function listProbes(sql: SQL, proposalId: string): Promise<ProbeRecord[]> {
  const rows = (await sql`
    select * from probes where proposal_id = ${proposalId} order by created_at asc, id asc
  `) as ProbeRow[];
  return rows.map(mapProbe);
}

/* ------------------------------------------------------------ lesson rows */

interface LessonRow {
  id: string;
  factory: string;
  cue: string;
  lesson: string;
  evidence: unknown;
  confidence: unknown;
  proposal_id: string | null;
  origin_factory: string;
  promoted: boolean;
  promoted_by: string | null;
  promoted_at: unknown;
  created_at: unknown;
}

function mapLesson(row: LessonRow): LessonRecord {
  return {
    id: row.id,
    factory: row.factory,
    cue: row.cue,
    lesson: row.lesson,
    evidence: parseJsonb<Record<string, unknown>>(row.evidence, {}),
    confidence: numOrZero(row.confidence),
    proposalId: row.proposal_id,
    originFactory: row.origin_factory,
    promoted: row.promoted,
    promotedBy: row.promoted_by,
    promotedAt: iso(row.promoted_at),
    createdAt: iso(row.created_at),
  };
}

export interface RecordLessonArgs {
  id: string;
  factory: string;
  cue: string;
  lesson: string;
  evidence?: Record<string, unknown>;
  confidence: number;
  proposalId?: string | null;
}

export async function recordLesson(sql: SQL, args: RecordLessonArgs): Promise<LessonRecord> {
  await sql`
    insert into lessons (
      id, factory, cue, lesson, evidence, confidence, proposal_id, origin_factory
    ) values (
      ${args.id}, ${args.factory}, ${args.cue}, ${args.lesson},
      ${JSON.stringify(args.evidence ?? {})}::jsonb, ${args.confidence},
      ${args.proposalId ?? null}, ${args.factory}
    )
    on conflict (id) do nothing
  `;
  const rows = (await sql`select * from lessons where id = ${args.id} limit 1`) as LessonRow[];
  return mapLesson(rows[0] as LessonRow);
}

export async function getLesson(sql: SQL, id: string): Promise<LessonRecord | null> {
  const rows = (await sql`select * from lessons where id = ${id} limit 1`) as LessonRow[];
  return rows[0] ? mapLesson(rows[0]) : null;
}

/**
 * Lesson visibility. A factory always sees its own lessons; it sees another factory's
 * lessons only when they were explicitly promoted into the shared library (ADR-020).
 */
export async function listLessons(
  sql: SQL,
  filters: LessonFilters = {},
): Promise<LessonRecord[]> {
  const factory = filters.factory ?? null;
  const includeShared = filters.includeShared ?? true;
  const promoted = filters.promoted ?? null;
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);

  const rows = (await sql`
    select * from lessons
    where (
      ${factory}::text is null
      or factory = ${factory}
      or (${includeShared} and promoted)
    )
      and (${promoted}::boolean is null or promoted = ${promoted})
    order by created_at desc
    limit ${limit}
  `) as LessonRow[];
  return rows.map(mapLesson);
}

export async function promoteLesson(
  sql: SQL,
  args: { id: string; actor: string; reason?: string | null },
): Promise<LessonRecord> {
  const rows = (await sql`
    update lessons set
      promoted = true,
      promoted_by = ${args.actor},
      promoted_at = coalesce(promoted_at, now()),
      evidence = evidence || ${JSON.stringify({
        promotion: { actor: args.actor, reason: args.reason ?? null },
      })}::jsonb
    where id = ${args.id}
    returning *
  `) as LessonRow[];
  return mapLesson(rows[0] as LessonRow);
}

/* ------------------------------------------------------------ event rows */

interface ImprovementEventRow {
  id: number | string;
  improvement_run_id: string;
  factory: string;
  type: string;
  subject: string;
  payload: unknown;
  created_at: unknown;
}

function mapEvent(row: ImprovementEventRow): ImprovementEventRecord {
  return {
    id: Number(row.id),
    improvementRunId: row.improvement_run_id,
    factory: row.factory,
    type: row.type,
    subject: row.subject,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

export async function recordImprovementEvent(
  sql: SQL,
  args: {
    improvementRunId: string;
    factory: string;
    type: string;
    subject?: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ event: ImprovementEventRecord | null; appended: boolean }> {
  const rows = (await sql`
    insert into improvement_events (improvement_run_id, factory, type, subject, payload)
    values (
      ${args.improvementRunId}, ${args.factory}, ${args.type}, ${args.subject ?? ''},
      ${JSON.stringify(args.payload ?? {})}::jsonb
    )
    on conflict (improvement_run_id, type, subject) do nothing
    returning *
  `) as ImprovementEventRow[];

  if (rows.length > 0) return { event: mapEvent(rows[0] as ImprovementEventRow), appended: true };
  return { event: null, appended: false };
}

export async function listImprovementEvents(
  sql: SQL,
  improvementRunId: string,
): Promise<ImprovementEventRecord[]> {
  const rows = (await sql`
    select * from improvement_events
    where improvement_run_id = ${improvementRunId}
    order by id asc
  `) as ImprovementEventRow[];
  return rows.map(mapEvent);
}

/* ------------------------------------------------------------ canary rows */

interface CanaryRow {
  id: string;
  factory: string;
  proposal_id: string;
  candidate_version: string;
  stable_version: string;
  canary_percent: number | string;
  rollback_threshold: unknown;
  observation_window_hours: number | string;
  status: string;
  reason: string | null;
  started_at: unknown;
  ended_at: unknown;
}

function mapCanary(row: CanaryRow): CanaryRolloutRecord {
  return {
    id: row.id,
    factory: row.factory,
    proposalId: row.proposal_id,
    candidateVersion: row.candidate_version,
    stableVersion: row.stable_version,
    canaryPercent: Number(row.canary_percent),
    rollbackThreshold: numOrZero(row.rollback_threshold),
    observationWindowHours: Number(row.observation_window_hours),
    status: row.status as CanaryRolloutRecord['status'],
    reason: row.reason,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

export async function createCanaryRollout(
  sql: SQL,
  args: Omit<CanaryRolloutRecord, 'startedAt' | 'endedAt'>,
): Promise<CanaryRolloutRecord> {
  const rows = (await sql`
    insert into canary_rollouts (
      id, factory, proposal_id, candidate_version, stable_version, canary_percent,
      rollback_threshold, observation_window_hours, status, reason
    ) values (
      ${args.id}, ${args.factory}, ${args.proposalId}, ${args.candidateVersion},
      ${args.stableVersion}, ${args.canaryPercent}, ${args.rollbackThreshold},
      ${args.observationWindowHours}, ${args.status}, ${args.reason ?? null}
    )
    on conflict (id) do nothing
    returning *
  `) as CanaryRow[];
  if (rows[0]) return mapCanary(rows[0]);
  const existing = (await sql`
    select * from canary_rollouts where id = ${args.id} limit 1
  `) as CanaryRow[];
  return mapCanary(existing[0] as CanaryRow);
}

export async function listCanaryRollouts(
  sql: SQL,
  args: { factory?: string | null; limit?: number } = {},
): Promise<CanaryRolloutRecord[]> {
  const factory = args.factory ?? null;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const rows = (await sql`
    select * from canary_rollouts
    where (${factory}::text is null or factory = ${factory})
    order by started_at desc
    limit ${limit}
  `) as CanaryRow[];
  return rows.map(mapCanary);
}
