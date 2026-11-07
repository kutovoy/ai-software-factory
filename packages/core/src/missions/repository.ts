import type { SQL } from 'bun';
import type {
  GateDecisionValue,
  WorkItem,
} from '../work-items/types';
import { mapWorkItem, type WorkItemRow } from '../work-items/repository';
import type {
  Mission,
  MissionBudget,
  MissionCheckpoint,
  MissionEvent,
  MissionFeature,
  MissionFeatureStatus,
  MissionGate,
  MissionMilestone,
  MissionMilestoneStatus,
  MissionPlan,
  MissionValidation,
  MissionValidationKind,
  MissionValidationStatus,
} from './types';

/**
 * Mission repository (plain SQL over Bun's `SQL` client, matching the work-item pattern).
 *
 * Every function takes the `SQL` handle explicitly. Workflow activities may retry, so
 * creation/transition helpers are idempotent where the workflow can replay them.
 */

export interface MissionRow {
  id: string;
  factory: string;
  factory_id: string | null;
  title: string;
  goal: string;
  status: string;
  definition_commit: string;
  definition_dirty: boolean;
  factory_root: string;
  definition_version: string;
  canary_rollout_id: string | null;
  plan: unknown;
  plan_version: number | string;
  current_milestone_id: string | null;
  current_feature_id: string | null;
  workflow_id: string | null;
  attempt: number | string;
  budget: unknown;
  error: string | null;
  cancel_requested_at: unknown;
  cancel_actor: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface MissionMilestoneRow {
  id: string;
  mission_id: string;
  ordinal: number | string;
  title: string;
  description: string;
  status: string;
  validation_round: number | string;
  created_at: unknown;
  updated_at: unknown;
}

export interface MissionFeatureRow {
  id: string;
  mission_id: string;
  milestone_id: string;
  ordinal: number | string;
  title: string;
  description: string;
  status: string;
  depends_on: unknown;
  acceptance_check_ids: unknown;
  work_item_id: string | null;
  fix_for_feature_id: string | null;
  attempt: number | string;
  created_at: unknown;
  updated_at: unknown;
}

export interface MissionCheckpointRow {
  id: number | string;
  mission_id: string;
  seq: number | string;
  kind: string;
  milestone_id: string | null;
  feature_id: string | null;
  dedupe_key: string | null;
  state: unknown;
  created_at: unknown;
}

export interface MissionEventRow {
  id: number | string;
  mission_id: string;
  type: string;
  milestone_id: string | null;
  feature_id: string | null;
  actor: string | null;
  payload: unknown;
  created_at: unknown;
}

export interface MissionGateRow {
  mission_id: string;
  gate: string;
  attempt: number | string;
  workflow_id: string | null;
  decision: string | null;
  actor: string | null;
  reason: string | null;
  feedback: string | null;
  requested_at: unknown;
  sla_at: unknown;
  decided_at: unknown;
}

export interface MissionValidationRow {
  id: string;
  mission_id: string;
  milestone_id: string;
  round: number | string;
  kind: string;
  run_id: string | null;
  status: string;
  verdict: string | null;
  findings: unknown;
  evidence: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface MissionSummary extends Mission {
  featureTotal: number;
  featureDone: number;
  featureFailed: number;
  milestoneTotal: number;
  milestoneDone: number;
  spendUsd: number;
}

export interface MissionBudgetUsageRecord {
  costUsd: number;
  runs: number;
  startedAt: string | null;
}

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

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function mapMission(row: MissionRow): Mission {
  return {
    id: row.id,
    factory: row.factory,
    factoryId: row.factory_id,
    title: row.title,
    goal: row.goal,
    status: row.status as Mission['status'],
    definitionCommit: row.definition_commit,
    definitionDirty: row.definition_dirty === true,
    factoryRoot: row.factory_root,
    definitionVersion: row.definition_version === 'candidate' ? 'candidate' : 'stable',
    canaryRolloutId: row.canary_rollout_id,
    plan: parseJsonb<MissionPlan | null>(row.plan, null),
    planVersion: num(row.plan_version),
    currentMilestoneId: row.current_milestone_id,
    currentFeatureId: row.current_feature_id,
    workflowId: row.workflow_id,
    attempt: num(row.attempt, 1),
    budget: parseJsonb<MissionBudget>(row.budget, {}),
    error: row.error,
    cancelRequestedAt: iso(row.cancel_requested_at),
    cancelActor: row.cancel_actor,
    cancelReason: row.cancel_reason,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapMissionMilestone(row: MissionMilestoneRow): MissionMilestone {
  return {
    id: row.id,
    missionId: row.mission_id,
    ordinal: num(row.ordinal),
    title: row.title,
    description: row.description,
    status: row.status as MissionMilestoneStatus,
    validationRound: num(row.validation_round),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function mapMissionFeature(row: MissionFeatureRow): MissionFeature {
  return {
    id: row.id,
    missionId: row.mission_id,
    milestoneId: row.milestone_id,
    ordinal: num(row.ordinal),
    title: row.title,
    description: row.description,
    status: row.status as MissionFeatureStatus,
    dependsOn: parseJsonb<string[]>(row.depends_on, []),
    acceptanceCheckIds: parseJsonb<string[]>(row.acceptance_check_ids, []),
    workItemId: row.work_item_id,
    fixForFeatureId: row.fix_for_feature_id,
    attempt: num(row.attempt),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCheckpoint(row: MissionCheckpointRow): MissionCheckpoint {
  return {
    id: num(row.id),
    missionId: row.mission_id,
    seq: num(row.seq),
    kind: row.kind,
    milestoneId: row.milestone_id,
    featureId: row.feature_id,
    dedupeKey: row.dedupe_key,
    state: parseJsonb<Record<string, unknown>>(row.state, {}),
    createdAt: iso(row.created_at),
  };
}

function mapEvent(row: MissionEventRow): MissionEvent {
  return {
    id: num(row.id),
    missionId: row.mission_id,
    type: row.type,
    milestoneId: row.milestone_id,
    featureId: row.feature_id,
    actor: row.actor,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

function mapGate(row: MissionGateRow): MissionGate {
  return {
    missionId: row.mission_id,
    gate: row.gate,
    attempt: num(row.attempt, 1),
    workflowId: row.workflow_id,
    decision: (row.decision as GateDecisionValue | null) ?? null,
    actor: row.actor,
    reason: row.reason,
    feedback: row.feedback,
    requestedAt: iso(row.requested_at),
    slaAt: iso(row.sla_at),
    decidedAt: iso(row.decided_at),
  };
}

function mapValidation(row: MissionValidationRow): MissionValidation {
  return {
    id: row.id,
    missionId: row.mission_id,
    milestoneId: row.milestone_id,
    round: num(row.round, 1),
    kind: row.kind as MissionValidationKind,
    runId: row.run_id,
    status: row.status as MissionValidationStatus,
    verdict: (row.verdict as MissionValidation['verdict']) ?? null,
    findings: parseJsonb<Record<string, unknown>[]>(row.findings, []),
    evidence: parseJsonb<Record<string, unknown>[]>(row.evidence, []),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface CreateMissionArgs {
  id: string;
  factory: string;
  factoryId?: string | null;
  title: string;
  goal: string;
  definitionCommit: string;
  definitionDirty?: boolean;
  factoryRoot: string;
  definitionVersion?: 'stable' | 'candidate';
  canaryRolloutId?: string | null;
  workflowId?: string | null;
  attempt?: number;
  budget?: MissionBudget;
  createdBy?: string | null;
}

export async function createMission(sql: SQL, args: CreateMissionArgs): Promise<Mission> {
  return await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into missions (
        id, factory, factory_id, title, goal, status, definition_commit, definition_dirty,
        factory_root, definition_version, canary_rollout_id, workflow_id, attempt, budget,
        created_by
      ) values (
        ${args.id}, ${args.factory}, ${args.factoryId ?? null}, ${args.title}, ${args.goal},
        'planning', ${args.definitionCommit}, ${args.definitionDirty ?? false},
        ${args.factoryRoot}, ${args.definitionVersion ?? 'stable'},
        ${args.canaryRolloutId ?? null}, ${args.workflowId ?? null}, ${args.attempt ?? 1},
        ${(args.budget ?? {})}::jsonb, ${args.createdBy ?? null}
      )
      returning *
    `) as MissionRow[];

    await tx`
      insert into mission_events (mission_id, type, actor, payload)
      values (${args.id}, 'mission.created', ${args.createdBy ?? 'api'},
              ${({
                factory: args.factory,
                title: args.title,
                goal: args.goal,
                definitionCommit: args.definitionCommit,
                budget: args.budget ?? {},
              })}::jsonb)
    `;

    return mapMission(rows[0] as MissionRow);
  });
}

export async function getMission(sql: SQL, missionId: string): Promise<Mission | null> {
  const rows = (await sql`
    select * from missions where id = ${missionId} limit 1
  `) as MissionRow[];
  return rows[0] ? mapMission(rows[0]) : null;
}

export interface ListMissionsFilters {
  factory?: string;
  status?: string;
  createdBy?: string | null;
  limit?: number;
  offset?: number;
}

export async function listMissions(
  sql: SQL,
  filters: ListMissionsFilters = {},
): Promise<MissionSummary[]> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const factory = filters.factory ?? null;
  const status = filters.status ?? null;
  const createdBy = filters.createdBy ?? null;

  const rows = (await sql`
    select m.*,
      coalesce(f.total, 0)::int as feature_total,
      coalesce(f.done, 0)::int as feature_done,
      coalesce(f.failed, 0)::int as feature_failed,
      coalesce(ms.total, 0)::int as milestone_total,
      coalesce(ms.done, 0)::int as milestone_done,
      coalesce(sp.spend, 0)::numeric as spend_usd
    from missions m
    left join lateral (
      select
        count(*)::int as total,
        count(*) filter (where status = 'done')::int as done,
        count(*) filter (where status = 'failed')::int as failed
      from mission_features f
      where f.mission_id = m.id
    ) f on true
    left join lateral (
      select
        count(*)::int as total,
        count(*) filter (where status = 'done')::int as done
      from mission_milestones ms
      where ms.mission_id = m.id
    ) ms on true
    left join lateral (
      select coalesce(sum(cost_usd), 0)::numeric as spend
      from runs r
      where r.mission_id = m.id
    ) sp on true
    where (${factory}::text is null or m.factory = ${factory})
      and (${status}::text is null or m.status = ${status})
      and (${createdBy}::uuid is null or m.created_by = ${createdBy}::uuid)
    order by m.created_at desc
    limit ${limit} offset ${offset}
  `) as (MissionRow & {
    feature_total: number | string;
    feature_done: number | string;
    feature_failed: number | string;
    milestone_total: number | string;
    milestone_done: number | string;
    spend_usd: number | string;
  })[];

  return rows.map((row) => ({
    ...mapMission(row),
    featureTotal: num(row.feature_total),
    featureDone: num(row.feature_done),
    featureFailed: num(row.feature_failed),
    milestoneTotal: num(row.milestone_total),
    milestoneDone: num(row.milestone_done),
    spendUsd: num(row.spend_usd),
  }));
}

export interface UpdateMissionStatusArgs {
  missionId: string;
  status: Mission['status'];
  error?: string | null;
  currentMilestoneId?: string | null;
  currentFeatureId?: string | null;
  workflowId?: string | null;
  attempt?: number;
}

export async function updateMissionStatus(
  sql: SQL,
  args: UpdateMissionStatusArgs,
): Promise<Mission | null> {
  const rows = (await sql`
    update missions set
      status = ${args.status},
      error = ${args.error ?? null},
      current_milestone_id = coalesce(${args.currentMilestoneId ?? null}, current_milestone_id),
      current_feature_id = coalesce(${args.currentFeatureId ?? null}, current_feature_id),
      workflow_id = coalesce(${args.workflowId ?? null}, workflow_id),
      attempt = coalesce(${args.attempt ?? null}, attempt),
      updated_at = now()
    where id = ${args.missionId}
    returning *
  `) as MissionRow[];
  return rows[0] ? mapMission(rows[0]) : null;
}

export async function setMissionPlan(
  sql: SQL,
  missionId: string,
  plan: MissionPlan,
  planVersion: number,
): Promise<Mission | null> {
  const rows = (await sql`
    update missions set
      plan = ${plan}::jsonb,
      plan_version = ${planVersion},
      updated_at = now()
    where id = ${missionId}
    returning *
  `) as MissionRow[];
  return rows[0] ? mapMission(rows[0]) : null;
}

/** Persists the plan's milestones/features and updates the mission plan JSON. */
export async function persistMissionPlan(
  sql: SQL,
  missionId: string,
  plan: MissionPlan,
  planVersion: number,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update missions set plan = ${plan}::jsonb, plan_version = ${planVersion}, updated_at = now()
      where id = ${missionId}
    `;

    for (const milestone of plan.milestones) {
      const milestoneRows = (await tx`
        insert into mission_milestones (id, mission_id, ordinal, title, description, status)
        values (${milestone.id}, ${missionId}, ${milestone.order}, ${milestone.title},
                ${milestone.description}, 'pending')
        on conflict (id) do update set
          ordinal = excluded.ordinal,
          title = excluded.title,
          description = excluded.description,
          updated_at = now()
        where mission_milestones.mission_id = ${missionId}
        returning id
      `) as { id: string }[];
      if (milestoneRows.length === 0) {
        throw new Error(
          `mission plan milestone id "${milestone.id}" belongs to another mission`,
        );
      }

      for (const feature of milestone.features) {
        const featureRows = (await tx`
          insert into mission_features (
            id, mission_id, milestone_id, ordinal, title, description, status,
            depends_on, acceptance_check_ids, work_item_type
          ) values (
            ${feature.id}, ${missionId}, ${milestone.id}, ${feature.order}, ${feature.title},
            ${feature.description}, 'pending', ${feature.dependsOn}::jsonb,
            ${feature.acceptanceCheckIds}::jsonb, ${feature.workItemType ?? 'task'}
          )
          on conflict (id) do update set
            mission_id = excluded.mission_id,
            milestone_id = excluded.milestone_id,
            ordinal = excluded.ordinal,
            title = excluded.title,
            description = excluded.description,
            depends_on = excluded.depends_on,
            acceptance_check_ids = excluded.acceptance_check_ids,
            work_item_type = excluded.work_item_type,
            updated_at = now()
          where mission_features.mission_id = ${missionId}
          returning id
        `) as { id: string }[];
        if (featureRows.length === 0) {
          throw new Error(
            `mission plan feature id "${feature.id}" belongs to another mission`,
          );
        }
      }
    }
  });
}

export async function getMissionMilestone(
  sql: SQL,
  milestoneId: string,
): Promise<MissionMilestone | null> {
  const rows = (await sql`
    select * from mission_milestones where id = ${milestoneId} limit 1
  `) as MissionMilestoneRow[];
  return rows[0] ? mapMissionMilestone(rows[0]) : null;
}

export async function listMissionMilestones(
  sql: SQL,
  missionId: string,
): Promise<MissionMilestone[]> {
  const rows = (await sql`
    select * from mission_milestones where mission_id = ${missionId} order by ordinal asc
  `) as MissionMilestoneRow[];
  return rows.map(mapMissionMilestone);
}

export async function getMissionFeature(
  sql: SQL,
  featureId: string,
): Promise<MissionFeature | null> {
  const rows = (await sql`
    select * from mission_features where id = ${featureId} limit 1
  `) as MissionFeatureRow[];
  return rows[0] ? mapMissionFeature(rows[0]) : null;
}

export async function listMissionFeatures(
  sql: SQL,
  missionId: string,
): Promise<MissionFeature[]> {
  const rows = (await sql`
    select * from mission_features where mission_id = ${missionId} order by ordinal asc
  `) as MissionFeatureRow[];
  return rows.map(mapMissionFeature);
}

export interface CreateMissionFeatureArgs {
  id: string;
  missionId: string;
  milestoneId: string;
  ordinal: number;
  title: string;
  description: string;
  status?: MissionFeatureStatus;
  dependsOn?: string[];
  acceptanceCheckIds?: string[];
  workItemType?: string;
  workItemId?: string | null;
  fixForFeatureId?: string | null;
  attempt?: number;
}

/**
 * Inserts a feature that is not part of the approved plan JSON (mission fix features).
 * The plan itself is updated separately with `setMissionPlan`, so the workflow can
 * schedule the new feature on its next pass.
 */
export async function createMissionFeature(
  sql: SQL,
  args: CreateMissionFeatureArgs,
): Promise<MissionFeature> {
  const rows = (await sql`
    insert into mission_features (
      id, mission_id, milestone_id, ordinal, title, description, status,
      depends_on, acceptance_check_ids, work_item_type, work_item_id,
      fix_for_feature_id, attempt
    ) values (
      ${args.id}, ${args.missionId}, ${args.milestoneId}, ${args.ordinal}, ${args.title},
      ${args.description}, ${args.status ?? 'pending'}, ${(args.dependsOn ?? [])}::jsonb,
      ${(args.acceptanceCheckIds ?? [])}::jsonb, ${args.workItemType ?? 'task'},
      ${args.workItemId ?? null}, ${args.fixForFeatureId ?? null}, ${args.attempt ?? 0}
    )
    returning *
  `) as MissionFeatureRow[];
  return mapMissionFeature(rows[0] as MissionFeatureRow);
}

export async function setMissionFeatureStatus(
  sql: SQL,
  args: {
    featureId: string;
    status: MissionFeatureStatus;
    workItemId?: string | null;
    attempt?: number;
  },
): Promise<MissionFeature | null> {
  const rows = (await sql`
    update mission_features set
      status = ${args.status},
      work_item_id = coalesce(${args.workItemId ?? null}, work_item_id),
      attempt = coalesce(${args.attempt ?? null}, attempt),
      updated_at = now()
    where id = ${args.featureId}
    returning *
  `) as MissionFeatureRow[];
  return rows[0] ? mapMissionFeature(rows[0]) : null;
}

export async function linkFeatureWorkItem(
  sql: SQL,
  featureId: string,
  workItemId: string,
): Promise<void> {
  await sql`
    update mission_features set work_item_id = ${workItemId}, updated_at = now()
    where id = ${featureId}
  `;
}

export async function setMissionMilestoneStatus(
  sql: SQL,
  args: {
    milestoneId: string;
    status: MissionMilestoneStatus;
    validationRound?: number;
  },
): Promise<MissionMilestone | null> {
  const rows = (await sql`
    update mission_milestones set
      status = ${args.status},
      validation_round = coalesce(${args.validationRound ?? null}, validation_round),
      updated_at = now()
    where id = ${args.milestoneId}
    returning *
  `) as MissionMilestoneRow[];
  return rows[0] ? mapMissionMilestone(rows[0]) : null;
}

export async function appendMissionEvent(
  sql: SQL,
  args: {
    missionId: string;
    type: string;
    milestoneId?: string | null;
    featureId?: string | null;
    actor?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string | null;
  },
): Promise<void> {
  await sql`
    insert into mission_events (mission_id, type, milestone_id, feature_id, actor, payload, dedupe_key)
    values (${args.missionId}, ${args.type}, ${args.milestoneId ?? null},
            ${args.featureId ?? null}, ${args.actor ?? null}, ${(args.payload ?? {})}::jsonb,
            ${args.dedupeKey ?? null})
    on conflict (mission_id, dedupe_key) where dedupe_key is not null do nothing
  `;
}

export async function listMissionEvents(
  sql: SQL,
  missionId: string,
  limit = 200,
): Promise<MissionEvent[]> {
  const rows = (await sql`
    select * from mission_events where mission_id = ${missionId}
    order by id asc limit ${Math.min(Math.max(limit, 1), 1000)}
  `) as MissionEventRow[];
  return rows.map(mapEvent);
}

export async function recordMissionCheckpoint(
  sql: SQL,
  args: {
    missionId: string;
    kind: string;
    state: Record<string, unknown>;
    milestoneId?: string | null;
    featureId?: string | null;
    dedupeKey?: string | null;
  },
): Promise<MissionCheckpoint> {
  return await sql.begin(async (tx) => {
    if (args.dedupeKey) {
      const existing = (await tx`
        select * from mission_checkpoints
        where mission_id = ${args.missionId} and dedupe_key = ${args.dedupeKey}
        limit 1
      `) as MissionCheckpointRow[];
      if (existing[0]) return mapCheckpoint(existing[0]);
    }

    const seqRows = (await tx`
      select coalesce(max(seq), 0) + 1 as next_seq
      from mission_checkpoints where mission_id = ${args.missionId}
    `) as { next_seq: number | string }[];

    const rows = (await tx`
      insert into mission_checkpoints
        (mission_id, seq, kind, milestone_id, feature_id, dedupe_key, state)
      values (${args.missionId}, ${num(seqRows[0]?.next_seq, 1)}, ${args.kind},
              ${args.milestoneId ?? null}, ${args.featureId ?? null},
              ${args.dedupeKey ?? null}, ${args.state}::jsonb)
      returning *
    `) as MissionCheckpointRow[];
    return mapCheckpoint(rows[0] as MissionCheckpointRow);
  });
}

export async function listMissionCheckpoints(
  sql: SQL,
  missionId: string,
): Promise<MissionCheckpoint[]> {
  const rows = (await sql`
    select * from mission_checkpoints where mission_id = ${missionId}
    order by seq asc
  `) as MissionCheckpointRow[];
  return rows.map(mapCheckpoint);
}

export async function createMissionGate(
  sql: SQL,
  args: {
    missionId: string;
    gate: string;
    attempt?: number;
    workflowId?: string | null;
    slaAt?: string | null;
  },
): Promise<MissionGate> {
  const rows = (await sql`
    insert into mission_gates (mission_id, gate, attempt, workflow_id, sla_at)
    values (${args.missionId}, ${args.gate}, ${args.attempt ?? 1}, ${args.workflowId ?? null},
            ${args.slaAt ?? null})
    on conflict (mission_id, gate, attempt) do update set
      workflow_id = coalesce(excluded.workflow_id, mission_gates.workflow_id),
      sla_at = coalesce(excluded.sla_at, mission_gates.sla_at)
    returning *
  `) as MissionGateRow[];
  return mapGate(rows[0] as MissionGateRow);
}

export async function decideMissionGate(
  sql: SQL,
  args: {
    missionId: string;
    gate: string;
    attempt: number;
    decision: GateDecisionValue;
    actor: string;
    reason?: string | null;
    feedback?: string | null;
  },
): Promise<MissionGate | null> {
  const rows = (await sql`
    update mission_gates set
      decision = ${args.decision},
      actor = ${args.actor},
      reason = ${args.reason ?? null},
      feedback = ${args.feedback ?? null},
      decided_at = now()
    where mission_id = ${args.missionId} and gate = ${args.gate}
      and attempt = ${args.attempt} and decision is null
    returning *
  `) as MissionGateRow[];
  return rows[0] ? mapGate(rows[0]) : null;
}

export async function getPendingMissionGate(
  sql: SQL,
  missionId: string,
): Promise<MissionGate | null> {
  const rows = (await sql`
    select * from mission_gates
    where mission_id = ${missionId} and decision is null
    order by requested_at desc limit 1
  `) as MissionGateRow[];
  return rows[0] ? mapGate(rows[0]) : null;
}

export async function listMissionGates(
  sql: SQL,
  missionId: string,
): Promise<MissionGate[]> {
  const rows = (await sql`
    select * from mission_gates where mission_id = ${missionId} order by requested_at asc
  `) as MissionGateRow[];
  return rows.map(mapGate);
}

export async function createMissionValidation(
  sql: SQL,
  args: {
    id: string;
    missionId: string;
    milestoneId: string;
    round: number;
    kind: MissionValidationKind;
    runId?: string | null;
    status?: MissionValidationStatus;
  },
): Promise<MissionValidation> {
  const rows = (await sql`
    insert into mission_validations
      (id, mission_id, milestone_id, round, kind, run_id, status)
    values (${args.id}, ${args.missionId}, ${args.milestoneId}, ${args.round}, ${args.kind},
            ${args.runId ?? null}, ${args.status ?? 'pending'})
    returning *
  `) as MissionValidationRow[];
  return mapValidation(rows[0] as MissionValidationRow);
}

export async function updateMissionValidation(
  sql: SQL,
  args: {
    id: string;
    status: MissionValidationStatus;
    verdict?: MissionValidation['verdict'];
    findings?: Record<string, unknown>[];
    evidence?: Record<string, unknown>[];
  },
): Promise<MissionValidation | null> {
  const rows = (await sql`
    update mission_validations set
      status = ${args.status},
      verdict = coalesce(${args.verdict ?? null}, verdict),
      findings = ${(args.findings ?? [])}::jsonb,
      evidence = ${(args.evidence ?? [])}::jsonb,
      updated_at = now()
    where id = ${args.id}
    returning *
  `) as MissionValidationRow[];
  return rows[0] ? mapValidation(rows[0]) : null;
}

export async function listMissionValidations(
  sql: SQL,
  missionId: string,
): Promise<MissionValidation[]> {
  const rows = (await sql`
    select * from mission_validations where mission_id = ${missionId}
    order by created_at asc
  `) as MissionValidationRow[];
  return rows.map(mapValidation);
}

export async function listMissionWorkItems(
  sql: SQL,
  missionId: string,
): Promise<WorkItem[]> {
  const rows = (await sql`
    select * from work_items where mission_id = ${missionId} order by created_at asc
  `) as WorkItemRow[];
  return rows.map(mapWorkItem);
}

export async function missionBudgetUsage(
  sql: SQL,
  missionId: string,
): Promise<MissionBudgetUsageRecord> {
  const rows = (await sql`
    select
      coalesce(sum(r.cost_usd), 0)::numeric as cost_usd,
      count(r.id)::int as runs,
      m.created_at as started_at
    from missions m
    left join runs r on r.mission_id = m.id
    where m.id = ${missionId}
    group by m.id
  `) as { cost_usd: number | string; runs: number | string; started_at: unknown }[];
  const row = rows[0];
  return {
    costUsd: num(row?.cost_usd),
    runs: num(row?.runs),
    startedAt: iso(row?.started_at),
  };
}

export async function requestMissionCancel(
  sql: SQL,
  args: { missionId: string; actor: string; reason?: string | null },
): Promise<void> {
  await sql`
    update missions set
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_actor = coalesce(cancel_actor, ${args.actor}),
      cancel_reason = coalesce(cancel_reason, ${args.reason ?? null}),
      updated_at = now()
    where id = ${args.missionId}
  `;
}

export async function readMissionCancel(
  sql: SQL,
  missionId: string,
): Promise<{ requested: boolean; actor: string | null; reason: string | null }> {
  const rows = (await sql`
    select cancel_requested_at, cancel_actor, cancel_reason
    from missions where id = ${missionId} limit 1
  `) as {
    cancel_requested_at: unknown;
    cancel_actor: string | null;
    cancel_reason: string | null;
  }[];
  const row = rows[0];
  return {
    requested: Boolean(row?.cancel_requested_at),
    actor: row?.cancel_actor ?? null,
    reason: row?.cancel_reason ?? null,
  };
}
