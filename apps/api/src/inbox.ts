import {
  DEFAULT_QUALITY_STANDARDS,
  isProofKind,
  mapGate,
  mapMission,
  mapWorkItem,
  resolveSlopBudgets,
  type GateDecisionRecord,
  type GateDecisionRow,
  type MissionGate,
  type MissionRow,
  type MissionSummary,
  type ReviewPacket,
  type SlopBudget,
  type WorkItemRow,
} from '@factory/core';
import { getSql, type RunRow } from '@factory/orchestration';
import { ownerFilter, type Viewer } from './auth';
import { summarize as summarizeWorkItem, type WorkItemSummary } from './work-items';

/**
 * Batch inbox projection (performance plan, `docs/PERFORMANCE.md`).
 *
 * The console used to build the inbox from one list call per factory plus a detail call per
 * open run and per non-terminal work item (~112 API calls, each re-syncing the registry).
 * This endpoint answers the same question with three indexed queries: pending gates,
 * pending permissions and failed runs. Ownership is applied in SQL, so a member never sees
 * another member's rows.
 */

export interface InboxGate {
  workItem: WorkItemSummary;
  /** Stable factory id for links; falls back to the internal key for pre-identity rows. */
  factoryId: string;
  factoryName: string;
  gate: GateDecisionRecord;
  /**
   * Newest deterministic review packet recorded for the work item, or null when the loop has
   * not assembled one yet. Additive projection field: older clients simply ignore it.
   */
  reviewPacket: ReviewPacket | null;
}

export interface InboxPermission {
  runId: string;
  factoryId: string;
  factoryName: string;
  title: string;
  action: string;
  requestId: string;
  requestedAt: string;
  commit: string;
}

export interface InboxFailure {
  runId: string;
  factoryId: string;
  factoryName: string;
  title: string;
  at: string;
  commit: string;
  errorCode: string;
  error: string;
}

export interface InboxMission {
  mission: MissionSummary;
  factoryId: string;
  factoryName: string;
  /** Pending plan gate, when the mission is awaiting plan approval. */
  gate: MissionGate | null;
  /** Why a blocked mission is listed when no gate waits. */
  reason: string | null;
}

export interface InboxProjection {
  gates: InboxGate[];
  permissions: InboxPermission[];
  failures: InboxFailure[];
  missions: InboxMission[];
  counts: {
    gates: number;
    permissions: number;
    failures: number;
    missions: number;
  };
}

interface GateInboxRow extends WorkItemRow {
  g_stage: string;
  g_attempt: number | string;
  g_gate: string;
  g_workflow_id: string | null;
  g_decision: string | null;
  g_actor: string | null;
  g_reason: string | null;
  g_feedback: string | null;
  g_verdict: unknown;
  g_automatic: boolean;
  g_requested_at: unknown;
  g_sla_at: unknown;
  g_decided_at: unknown;
  /** Newest `review.packet` payload for the work item, or null. */
  review_packet: unknown;
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

interface PermissionInboxRow extends RunRow {
  request_id: string;
  action: string;
  detail: unknown;
  decision: string | null;
  requested_at: unknown;
  decided_at: unknown;
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

interface FailureInboxRow extends RunRow {
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  total_count: number | string;
}

interface MissionInboxRow extends MissionRow {
  g_gate: string | null;
  g_attempt: number | string | null;
  g_workflow_id: string | null;
  g_decision: string | null;
  g_actor: string | null;
  g_reason: string | null;
  g_feedback: string | null;
  g_requested_at: unknown;
  g_sla_at: unknown;
  g_decided_at: unknown;
  factory_identity: string | null;
  factory_name: string | null;
  factory_alias: string | null;
  feature_total: number | string;
  feature_done: number | string;
  feature_failed: number | string;
  milestone_total: number | string;
  milestone_done: number | string;
  spend_usd: number | string;
  total_count: number | string;
}

function factoryIdOf(row: {
  factory_id?: string | null;
  factory_identity: string | null;
  factory?: string | null;
}): string {
  return row.factory_id ?? row.factory_identity ?? row.factory ?? '';
}

function factoryLabel(row: {
  factory_alias: string | null;
  factory_name: string | null;
  factory?: string | null;
}): string {
  return row.factory_alias?.trim() || row.factory_name || row.factory || '';
}

function iso(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function errorCodeOf(error: string | null): string {
  return error ? (error.split(':')[0]?.trim() || 'run_failed') : 'run_failed';
}

const RISK_TIERS = new Set<ReviewPacket['riskTier']>(['low', 'medium', 'high']);

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Resolves a persisted single-tier budget against the shipped defaults. */
function slopBudgetOf(value: unknown, riskTier: ReviewPacket['riskTier']): SlopBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return resolveSlopBudgets()[riskTier];
  }
  return resolveSlopBudgets({
    slopBudget: { [riskTier]: value },
  } as unknown as Parameters<typeof resolveSlopBudgets>[0])[riskTier];
}

function slopStatusOf(value: unknown): ReviewPacket['slopStatus'] {
  return value === 'pass' || value === 'exceeded' || value === 'unknown' ? value : 'unknown';
}

/** Clamps a standards count to a non-negative integer; negative/NaN/non-number → 0. */
function standardsCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Defensive standards projection (change `add-risk-aware-routing-and-standards`). A packet
 * written before the standards guard carries no `standards` field; the honest fallback uses
 * the shipped caps and the packet's measured blast radius, and reports `pass` (an older packet
 * was never blocked by standards). Only `pass`/`exceeded` are accepted as a status.
 */
function standardsOf(
  value: unknown,
  blastRadius: ReviewPacket['blastRadius'],
): ReviewPacket['standards'] {
  const record = recordOf(value);
  if (Object.keys(record).length === 0) {
    return {
      maxPublicApiChanges: DEFAULT_QUALITY_STANDARDS.maxPublicApiChanges,
      maxSchemaChanges: DEFAULT_QUALITY_STANDARDS.maxSchemaChanges,
      publicApiChanges: blastRadius.publicApiChanges,
      schemaChanges: blastRadius.schemaChanges,
      status: 'pass',
    };
  }
  return {
    maxPublicApiChanges: standardsCount(record.maxPublicApiChanges),
    maxSchemaChanges: standardsCount(record.maxSchemaChanges),
    publicApiChanges: standardsCount(record.publicApiChanges),
    schemaChanges: standardsCount(record.schemaChanges),
    status: record.status === 'exceeded' ? 'exceeded' : 'pass',
  };
}

/**
 * Defensive projection of a `review.packet` payload. The event is written by the orchestrator,
 * but an older or partially-written row must never crash the inbox: a payload without a valid
 * risk tier is treated as absent, and every other field is normalised to the documented shape.
 */
function reviewPacketOf(value: unknown): ReviewPacket | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const riskTier =
    typeof record.riskTier === 'string' && RISK_TIERS.has(record.riskTier as ReviewPacket['riskTier'])
      ? (record.riskTier as ReviewPacket['riskTier'])
      : null;
  if (!riskTier) return null;

  const diff =
    record.diffStats && typeof record.diffStats === 'object' && !Array.isArray(record.diffStats)
      ? (record.diffStats as Record<string, unknown>)
      : {};
  const assertions = Array.isArray(record.assertions)
    ? record.assertions.map((assertion) => {
        const item = (assertion ?? {}) as Record<string, unknown>;
        return {
          id: typeof item.id === 'string' ? item.id : '',
          status: typeof item.status === 'string' ? item.status : 'unknown',
          evidence: typeof item.evidence === 'string' ? item.evidence : '',
        };
      })
    : [];

  // Review packet v2 (change `add-anti-slop-budgets-and-proof`): every new field is parsed
  // defensively. A payload written before v2 has none of them, so the honest defaults are
  // used — an unknown slop status, no proof, no decisions — never fabricated values.
  const actual = recordOf(record.slopActual);
  const blastRadius = recordOf(record.blastRadius);
  const comprehension = recordOf(record.comprehension);
  const proofArtifacts: ReviewPacket['proofArtifacts'] = Array.isArray(record.proofArtifacts)
    ? record.proofArtifacts.flatMap((entry) => {
        const item = recordOf(entry);
        if (!isProofKind(item.kind) || typeof item.path !== 'string') return [];
        return [
          {
            kind: item.kind,
            path: item.path,
            label: typeof item.label === 'string' ? item.label : '',
            ...(typeof item.commit === 'string' ? { commit: item.commit } : {}),
            ...(typeof item.hash === 'string' ? { hash: item.hash } : {}),
          },
        ];
      })
    : [];
  const readFirst: ReviewPacket['readFirst'] = Array.isArray(record.readFirst)
    ? record.readFirst.flatMap((entry) => {
        const item = recordOf(entry);
        if (typeof item.path !== 'string') return [];
        return [{ path: item.path, why: typeof item.why === 'string' ? item.why : '' }];
      })
    : [];
  const decisions: ReviewPacket['decisions'] = Array.isArray(record.decisions)
    ? record.decisions.map((entry) => {
        const item = recordOf(entry);
        return {
          at: typeof item.at === 'string' ? item.at : '',
          actor: typeof item.actor === 'string' ? item.actor : '',
          decision: typeof item.decision === 'string' ? item.decision : '',
          reason: typeof item.reason === 'string' ? item.reason : '',
          ...(typeof item.ref === 'string' ? { ref: item.ref } : {}),
        };
      })
    : [];
  const reviewerRoles = stringList(record.reviewerRoles);
  const contextPackRef = typeof record.contextPackRef === 'string' ? record.contextPackRef : null;
  const projectedBlastRadius: ReviewPacket['blastRadius'] = {
    paths: stringList(blastRadius.paths),
    highRiskPaths: stringList(blastRadius.highRiskPaths),
    publicApiChanges: finiteNumber(blastRadius.publicApiChanges),
    schemaChanges: finiteNumber(blastRadius.schemaChanges),
  };

  return {
    riskTier,
    intent: typeof record.intent === 'string' ? record.intent : '',
    planRef: typeof record.planRef === 'string' ? record.planRef : null,
    changedFiles: finiteNumber(record.changedFiles),
    diffStats: {
      additions: finiteNumber(diff.additions),
      deletions: finiteNumber(diff.deletions),
    },
    assertions,
    architectureImpact: stringList(record.architectureImpact),
    openQuestions: stringList(record.openQuestions),
    reviewerChecklist: stringList(record.reviewerChecklist),
    slopBudget: slopBudgetOf(record.slopBudget, riskTier),
    slopActual: {
      changedFiles: finiteNumber(actual.changedFiles),
      additions: finiteNumber(actual.additions),
      deletions: finiteNumber(actual.deletions),
      diffLines: finiteNumber(actual.diffLines),
      newDependencies: finiteNumber(actual.newDependencies),
      duplicationDeltaPercent: nullableNumber(actual.duplicationDeltaPercent),
      complexityDelta: nullableNumber(actual.complexityDelta),
    },
    slopStatus: slopStatusOf(record.slopStatus),
    blastRadius: projectedBlastRadius,
    standards: standardsOf(record.standards, projectedBlastRadius),
    proofArtifacts,
    readFirst,
    decisions,
    reviewerRoles: reviewerRoles.length > 0 ? reviewerRoles : ['correctness'],
    comprehension: {
      estimatedReadMinutes: finiteNumber(comprehension.estimatedReadMinutes),
      filesWithoutTests: finiteNumber(comprehension.filesWithoutTests),
      modulesWithoutOwner: finiteNumber(comprehension.modulesWithoutOwner),
    },
    contextPackRef,
  };
}

export async function getInboxForApi(
  viewer: Viewer | null,
  options: { limit?: number } = {},
): Promise<InboxProjection> {
  const sql = getSql();
  const owner = ownerFilter(viewer);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const [gateRows, permissionRows, failureRows, missionRows] = await Promise.all([
    sql`
      select
        w.*,
        r.retry_count,
        r.retried_at,
        g.stage as g_stage,
        g.attempt as g_attempt,
        g.gate as g_gate,
        g.workflow_id as g_workflow_id,
        g.decision as g_decision,
        g.actor as g_actor,
        g.reason as g_reason,
        g.feedback as g_feedback,
        g.verdict as g_verdict,
        g.automatic as g_automatic,
        g.requested_at as g_requested_at,
        g.sla_at as g_sla_at,
        g.decided_at as g_decided_at,
        rp.payload as review_packet,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from gate_decisions g
      join work_items w on w.id = g.work_item_id
      left join lateral (
        select count(*)::int as retry_count, max(e.created_at) as retried_at
        from work_item_events e
        where e.work_item_id = w.id and e.type = 'work_item.retried'
      ) r on true
      left join lateral (
        select e.payload
        from work_item_events e
        where e.work_item_id = w.id and e.type = 'review.packet'
        order by e.id desc
        limit 1
      ) rp on true
      left join factories f on f.key = w.factory
      where g.decision is null
        and (${owner}::uuid is null or w.created_by = ${owner}::uuid)
      order by g.requested_at desc
      limit ${limit}
    `,
    sql`
      select
        r.*,
        rp.request_id,
        rp.action,
        rp.detail,
        rp.decision,
        rp.requested_at,
        rp.decided_at,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from run_permissions rp
      join runs r on r.id = rp.run_id
      left join work_items w on w.id = 'wi_' || substr(r.id, 5, 26)
      left join factories f on f.key = r.factory
      where rp.decision is null
        and (
          ${owner}::uuid is null
          or r.created_by = ${owner}::uuid
          or w.created_by = ${owner}::uuid
        )
      order by rp.requested_at desc
      limit ${limit}
    `,
    sql`
      select
        r.*,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        count(*) over() as total_count
      from runs r
      left join work_items w on w.id = 'wi_' || substr(r.id, 5, 26)
      left join factories f on f.key = r.factory
      where r.status = 'error'
        and (
          ${owner}::uuid is null
          or r.created_by = ${owner}::uuid
          or w.created_by = ${owner}::uuid
        )
      order by coalesce(r.ended_at, r.started_at) desc
      limit ${limit}
    `,
    sql`
      select
        m.*,
        mg.gate as g_gate,
        mg.attempt as g_attempt,
        mg.workflow_id as g_workflow_id,
        mg.decision as g_decision,
        mg.actor as g_actor,
        mg.reason as g_reason,
        mg.feedback as g_feedback,
        mg.requested_at as g_requested_at,
        mg.sla_at as g_sla_at,
        mg.decided_at as g_decided_at,
        f.id as factory_identity,
        f.name as factory_name,
        f.alias as factory_alias,
        coalesce(feature_counts.total, 0)::int as feature_total,
        coalesce(feature_counts.done, 0)::int as feature_done,
        coalesce(feature_counts.failed, 0)::int as feature_failed,
        coalesce(milestone_counts.total, 0)::int as milestone_total,
        coalesce(milestone_counts.done, 0)::int as milestone_done,
        coalesce(spend.spend, 0)::numeric as spend_usd,
        count(*) over() as total_count
      from missions m
      left join lateral (
        select g.* from mission_gates g
        where g.mission_id = m.id and g.decision is null
        order by g.requested_at desc limit 1
      ) mg on true
      left join factories f on f.key = m.factory
      left join lateral (
        select
          count(*)::int as total,
          count(*) filter (where status = 'done')::int as done,
          count(*) filter (where status = 'failed')::int as failed
        from mission_features mf where mf.mission_id = m.id
      ) feature_counts on true
      left join lateral (
        select
          count(*)::int as total,
          count(*) filter (where status = 'done')::int as done
        from mission_milestones mm where mm.mission_id = m.id
      ) milestone_counts on true
      left join lateral (
        select coalesce(sum(r.cost_usd), 0)::numeric as spend
        from runs r where r.mission_id = m.id
      ) spend on true
      where (m.status = 'awaiting_plan_approval' or m.status = 'blocked')
        and (${owner}::uuid is null or m.created_by = ${owner}::uuid)
      order by coalesce(mg.requested_at, m.updated_at) desc
      limit ${limit}
    `,
  ]) as [GateInboxRow[], PermissionInboxRow[], FailureInboxRow[], MissionInboxRow[]];

  const gates: InboxGate[] = gateRows.map((row) => ({
    workItem: summarizeWorkItem(mapWorkItem(row)),
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    reviewPacket: reviewPacketOf(row.review_packet),
    gate: mapGate({
      work_item_id: row.id,
      stage: row.g_stage,
      attempt: row.g_attempt,
      gate: row.g_gate,
      workflow_id: row.g_workflow_id,
      decision: row.g_decision,
      actor: row.g_actor,
      reason: row.g_reason,
      feedback: row.g_feedback,
      verdict: row.g_verdict,
      automatic: row.g_automatic === true,
      requested_at: row.g_requested_at,
      sla_at: row.g_sla_at,
      decided_at: row.g_decided_at,
    } satisfies GateDecisionRow),
  }));

  const permissions: InboxPermission[] = permissionRows.map((row) => ({
    runId: row.id,
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    title: row.title ?? row.id,
    action: row.action,
    requestId: row.request_id,
    requestedAt: iso(row.requested_at),
    commit: row.definition_commit,
  }));

  const failures: InboxFailure[] = failureRows.map((row) => ({
    runId: row.id,
    factoryId: factoryIdOf(row),
    factoryName: factoryLabel(row),
    title: row.title ?? row.id,
    at: iso(row.ended_at ?? row.started_at),
    commit: row.definition_commit,
    errorCode: errorCodeOf(row.error),
    error: row.error ?? 'the run ended with status error',
  }));

  const missions: InboxMission[] = missionRows.map((row) => {
    const mission = mapMission(row);
    const gate =
      row.g_gate !== null
        ? {
            missionId: mission.id,
            gate: row.g_gate,
            attempt: Number(row.g_attempt ?? 1),
            workflowId: row.g_workflow_id,
            decision: (row.g_decision as MissionGate['decision']) ?? null,
            actor: row.g_actor,
            reason: row.g_reason,
            feedback: row.g_feedback,
            requestedAt: iso(row.g_requested_at) || null,
            slaAt: iso(row.g_sla_at) || null,
            decidedAt: iso(row.g_decided_at) || null,
          }
        : null;

    return {
      mission: {
        ...mission,
        featureTotal: Number(row.feature_total ?? 0),
        featureDone: Number(row.feature_done ?? 0),
        featureFailed: Number(row.feature_failed ?? 0),
        milestoneTotal: Number(row.milestone_total ?? 0),
        milestoneDone: Number(row.milestone_done ?? 0),
        spendUsd: Number(row.spend_usd ?? 0),
      },
      factoryId: factoryIdOf(row),
      factoryName: factoryLabel(row),
      gate,
      reason: mission.error,
    };
  });

  return {
    gates,
    permissions,
    failures,
    missions,
    counts: {
      gates: Number(gateRows[0]?.total_count ?? gates.length),
      permissions: Number(permissionRows[0]?.total_count ?? permissions.length),
      failures: Number(failureRows[0]?.total_count ?? failures.length),
      missions: Number(missionRows[0]?.total_count ?? missions.length),
    },
  };
}
