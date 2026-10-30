import type { SQL } from 'bun';
import type {
  CalibrationItemRecord,
  CalibrationResultRecord,
  CalibrationSetRecord,
  CalibrationVerdict,
  ScoreAggregate,
  ScoreEventRecord,
  ScoreEvidenceRecord,
  ScoreFilters,
  ScoreProvenance,
  ScoreRecord,
  ScoreRunRecord,
  ScoreStatus,
  ScoreTrigger,
  ScorerClass,
  ScorerDefinitionRecord,
  ScorerLabelRecord,
} from './types';

/**
 * Scoring repository (ADR-010: plain SQL, explicit `SQL` handle).
 *
 * Idempotency: score ids are derived from `(runId, scorer, rubricHash)`, scores upsert on
 * that triple, evidence is replaced, and `score_events` is deduped by `(score_id, type)`.
 * A Temporal retry therefore never writes a second score or a second event.
 */

/* ---------------------------------------------------------------- helpers */

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

/* -------------------------------------------------------------- scorer rows */

interface ScorerDefinitionRow {
  factory: string;
  name: string;
  scorer_class: string;
  rubric_hash: string;
  judge_model: string;
  labels: unknown;
  passing_score: unknown;
  sampling_rate: number | string;
  self_improvement: boolean;
  checks: unknown;
  body: string;
  definition_commit: string | null;
  updated_at: unknown;
}

function mapScorerDefinition(row: ScorerDefinitionRow): ScorerDefinitionRecord {
  return {
    factory: row.factory,
    name: row.name,
    scorerClass: row.scorer_class as ScorerClass,
    rubricHash: row.rubric_hash,
    judgeModel: row.judge_model,
    labels: parseJsonb<ScorerLabelRecord[]>(row.labels, []),
    passingScore: numOrZero(row.passing_score),
    samplingRate: Number(row.sampling_rate),
    selfImprovement: row.self_improvement,
    checks: parseJsonb<string[]>(row.checks, []),
    body: row.body,
    definitionCommit: row.definition_commit,
    updatedAt: iso(row.updated_at),
  };
}

export interface UpsertScorerDefinitionArgs {
  factory: string;
  name: string;
  scorerClass: ScorerClass;
  rubricHash: string;
  judgeModel: string;
  labels: ScorerLabelRecord[];
  passingScore: number;
  samplingRate: number;
  selfImprovement: boolean;
  checks: string[];
  body: string;
  definitionCommit?: string | null;
}

export async function upsertScorerDefinition(
  sql: SQL,
  args: UpsertScorerDefinitionArgs,
): Promise<ScorerDefinitionRecord> {
  const rows = (await sql`
    insert into scorer_definitions (
      factory, name, scorer_class, rubric_hash, judge_model, labels, passing_score,
      sampling_rate, self_improvement, checks, body, definition_commit, updated_at
    ) values (
      ${args.factory}, ${args.name}, ${args.scorerClass}, ${args.rubricHash},
      ${args.judgeModel}, ${args.labels}::jsonb, ${args.passingScore},
      ${args.samplingRate}, ${args.selfImprovement}, ${args.checks}::jsonb,
      ${args.body}, ${args.definitionCommit ?? null}, now()
    )
    on conflict (factory, name, rubric_hash) do update set
      scorer_class = excluded.scorer_class,
      judge_model = excluded.judge_model,
      labels = excluded.labels,
      passing_score = excluded.passing_score,
      sampling_rate = excluded.sampling_rate,
      self_improvement = excluded.self_improvement,
      checks = excluded.checks,
      body = excluded.body,
      definition_commit = coalesce(excluded.definition_commit, scorer_definitions.definition_commit),
      updated_at = now()
    returning *
  `) as ScorerDefinitionRow[];
  return mapScorerDefinition(rows[0] as ScorerDefinitionRow);
}

/** Current definition per scorer (latest rubric version). */
export async function listScorerDefinitions(
  sql: SQL,
  factory: string,
): Promise<ScorerDefinitionRecord[]> {
  const rows = (await sql`
    select distinct on (name) *
    from scorer_definitions
    where factory = ${factory}
    order by name asc, updated_at desc
  `) as ScorerDefinitionRow[];
  return rows.map(mapScorerDefinition);
}

/* ------------------------------------------------------------- score runs */

interface ScoreRunRow {
  id: string;
  factory: string;
  run_id: string | null;
  work_item_id: string | null;
  stage: string | null;
  trigger: string;
  status: string;
  scorers: number | string;
  scored: number | string;
  skipped: number | string;
  errored: number | string;
  budget_exhausted: boolean;
  window_days: number | string | null;
  error: string | null;
  started_at: unknown;
  ended_at: unknown;
}

function mapScoreRun(row: ScoreRunRow): ScoreRunRecord {
  return {
    id: row.id,
    factory: row.factory,
    runId: row.run_id,
    workItemId: row.work_item_id,
    stage: row.stage,
    trigger: row.trigger as ScoreTrigger,
    status: row.status as ScoreRunRecord['status'],
    scorers: Number(row.scorers),
    scored: Number(row.scored),
    skipped: Number(row.skipped),
    errored: Number(row.errored),
    budgetExhausted: row.budget_exhausted,
    windowDays: row.window_days === null ? null : Number(row.window_days),
    error: row.error,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

export interface CreateScoreRunArgs {
  id: string;
  factory: string;
  runId?: string | null;
  workItemId?: string | null;
  stage?: string | null;
  trigger: ScoreTrigger;
  windowDays?: number | null;
}

export async function createScoreRun(
  sql: SQL,
  args: CreateScoreRunArgs,
): Promise<ScoreRunRecord> {
  await sql`
    insert into score_runs (
      id, factory, run_id, work_item_id, stage, trigger, status, window_days, started_at
    ) values (
      ${args.id}, ${args.factory}, ${args.runId ?? null}, ${args.workItemId ?? null},
      ${args.stage ?? null}, ${args.trigger}, 'running', ${args.windowDays ?? null}, now()
    )
    on conflict (id) do nothing
  `;
  const rows = (await sql`select * from score_runs where id = ${args.id} limit 1`) as ScoreRunRow[];
  return mapScoreRun(rows[0] as ScoreRunRow);
}

export async function finishScoreRun(
  sql: SQL,
  args: {
    id: string;
    status: 'completed' | 'error';
    scorers: number;
    scored: number;
    skipped: number;
    errored: number;
    budgetExhausted: boolean;
    error?: string | null;
  },
): Promise<ScoreRunRecord> {
  const rows = (await sql`
    update score_runs set
      status = ${args.status},
      scorers = ${args.scorers},
      scored = ${args.scored},
      skipped = ${args.skipped},
      errored = ${args.errored},
      budget_exhausted = ${args.budgetExhausted},
      error = ${args.error ?? null},
      ended_at = coalesce(ended_at, now())
    where id = ${args.id}
    returning *
  `) as ScoreRunRow[];
  return mapScoreRun(rows[0] as ScoreRunRow);
}

/* ---------------------------------------------------------------- scores */

interface ScoreRow {
  id: string;
  score_run_id: string | null;
  factory: string;
  run_id: string;
  work_item_id: string | null;
  stage: string | null;
  scorer: string;
  scorer_class: string;
  rubric_hash: string;
  status: string;
  error_code: string | null;
  label: string | null;
  score: unknown;
  passing: boolean;
  rationale: string | null;
  evidence_refs: unknown;
  uncalibrated: boolean;
  judge_model: string | null;
  judge_model_version: string | null;
  prompt_hash: string | null;
  input_tokens: unknown;
  output_tokens: unknown;
  cost_usd: unknown;
  created_at: unknown;
  evidence?: unknown;
}

function mapScore(row: ScoreRow, evidence?: ScoreEvidenceRecord[]): ScoreRecord {
  const parsedEvidence = evidence ?? parseJsonb<ScoreEvidenceRecord[]>(row.evidence, []);
  return {
    id: row.id,
    scoreRunId: row.score_run_id,
    factory: row.factory,
    runId: row.run_id,
    workItemId: row.work_item_id,
    stage: row.stage,
    scorer: row.scorer,
    scorerClass: row.scorer_class as ScorerClass,
    rubricHash: row.rubric_hash,
    status: row.status as ScoreStatus,
    errorCode: row.error_code,
    label: row.label,
    score: num(row.score),
    passing: row.passing,
    rationale: row.rationale,
    evidenceRefs: parseJsonb<string[]>(row.evidence_refs, []),
    uncalibrated: row.uncalibrated,
    provenance: {
      judgeModel: row.judge_model,
      judgeModelVersion: row.judge_model_version,
      promptHash: row.prompt_hash,
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      costUsd: num(row.cost_usd),
    },
    createdAt: iso(row.created_at),
    evidence: parsedEvidence,
  };
}

interface ScoreEvidenceRow {
  score_id: string;
  kind: string;
  ref: string;
  detail: unknown;
}

function mapEvidence(row: ScoreEvidenceRow): ScoreEvidenceRecord {
  return {
    kind: row.kind,
    ref: row.ref,
    detail: parseJsonb<Record<string, unknown>>(row.detail, {}),
  };
}

export interface RecordScoreArgs {
  id: string;
  scoreRunId?: string | null;
  factory: string;
  runId: string;
  workItemId?: string | null;
  stage?: string | null;
  scorer: string;
  scorerClass: ScorerClass;
  rubricHash: string;
  status: ScoreStatus;
  errorCode?: string | null;
  label?: string | null;
  score?: number | null;
  passing?: boolean;
  rationale?: string | null;
  evidenceRefs?: string[];
  evidence?: { kind: string; ref: string; detail?: Record<string, unknown> }[];
  uncalibrated?: boolean;
  provenance?: Partial<ScoreProvenance>;
}

export interface RecordScoreResult {
  score: ScoreRecord;
  eventType: string;
  eventAppended: boolean;
}

/** Upserts one score, replaces its evidence, and emits one deduped score event. */
export async function recordScore(sql: SQL, args: RecordScoreArgs): Promise<RecordScoreResult> {
  const evidence = dedupeEvidence(args.evidence ?? []);
  const eventType = args.status === 'skipped' ? 'score.skipped' : 'score.completed';

  const result = await sql.begin(async (tx) => {
    const rows = (await tx`
      insert into scores (
        id, score_run_id, factory, run_id, work_item_id, stage, scorer, scorer_class,
        rubric_hash, status, error_code, label, score, passing, rationale, evidence_refs,
        uncalibrated, judge_model, judge_model_version, prompt_hash, input_tokens,
        output_tokens, cost_usd, created_at
      ) values (
        ${args.id}, ${args.scoreRunId ?? null}, ${args.factory}, ${args.runId},
        ${args.workItemId ?? null}, ${args.stage ?? null}, ${args.scorer}, ${args.scorerClass},
        ${args.rubricHash}, ${args.status}, ${args.errorCode ?? null}, ${args.label ?? null},
        ${args.score ?? null}, ${args.passing ?? false}, ${args.rationale ?? null},
        ${(args.evidenceRefs ?? evidence.map((item) => item.ref))}::jsonb,
        ${args.uncalibrated ?? false}, ${args.provenance?.judgeModel ?? null},
        ${args.provenance?.judgeModelVersion ?? null}, ${args.provenance?.promptHash ?? null},
        ${args.provenance?.inputTokens ?? null}, ${args.provenance?.outputTokens ?? null},
        ${args.provenance?.costUsd ?? null}, now()
      )
      on conflict (run_id, scorer, rubric_hash) do update set
        score_run_id = excluded.score_run_id,
        work_item_id = excluded.work_item_id,
        stage = excluded.stage,
        status = excluded.status,
        error_code = excluded.error_code,
        label = excluded.label,
        score = excluded.score,
        passing = excluded.passing,
        rationale = excluded.rationale,
        evidence_refs = excluded.evidence_refs,
        uncalibrated = excluded.uncalibrated,
        judge_model = excluded.judge_model,
        judge_model_version = excluded.judge_model_version,
        prompt_hash = excluded.prompt_hash,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cost_usd = excluded.cost_usd,
        created_at = now()
      returning *
    `) as ScoreRow[];

    const row = rows[0] as ScoreRow;
    await tx`delete from score_evidence where score_id = ${row.id}`;
    for (const item of evidence) {
      await tx`
        insert into score_evidence (score_id, kind, ref, detail)
        values (${row.id}, ${item.kind}, ${item.ref},
                ${(item.detail ?? {})}::jsonb)
        on conflict (score_id, kind, ref) do nothing
      `;
    }

    const inserted = (await tx`
      insert into score_events (score_id, factory, run_id, type, payload)
      values (
        ${row.id}, ${args.factory}, ${args.runId}, ${eventType},
        ${({
          scoreId: row.id,
          runId: args.runId,
          factory: args.factory,
          scorer: args.scorer,
          scorerClass: args.scorerClass,
          status: args.status,
          errorCode: args.errorCode ?? null,
          label: args.label ?? null,
          score: args.score ?? null,
          passing: args.passing ?? false,
          uncalibrated: args.uncalibrated ?? false,
          rubricHash: args.rubricHash,
          judgeModel: args.provenance?.judgeModel ?? null,
          promptHash: args.provenance?.promptHash ?? null,
          costUsd: args.provenance?.costUsd ?? null,
        })}::jsonb
      )
      on conflict (score_id, type) do nothing
      returning id
    `) as { id: number }[];

    return {
      score: mapScore(row, evidence),
      eventType,
      eventAppended: inserted.length > 0,
    };
  });

  return result;
}

function dedupeEvidence(
  evidence: { kind: string; ref: string; detail?: Record<string, unknown> }[],
): ScoreEvidenceRecord[] {
  const seen = new Map<string, ScoreEvidenceRecord>();
  for (const item of evidence) {
    const key = `${item.kind}\u0000${item.ref}`;
    if (!seen.has(key)) {
      seen.set(key, { kind: item.kind, ref: item.ref, detail: item.detail ?? {} });
    }
  }
  return [...seen.values()];
}

export async function getScore(
  sql: SQL,
  id: string,
): Promise<{ score: ScoreRecord; events: ScoreEventRecord[] } | null> {
  const rows = (await sql`select * from scores where id = ${id} limit 1`) as ScoreRow[];
  const row = rows[0];
  if (!row) return null;

  const evidenceRows = (await sql`
    select * from score_evidence where score_id = ${id} order by kind asc, ref asc
  `) as ScoreEvidenceRow[];
  const events = await listScoreEvents(sql, id);

  return {
    score: mapScore(row, evidenceRows.map(mapEvidence)),
    events,
  };
}

export async function listScoreEvents(sql: SQL, scoreId: string): Promise<ScoreEventRecord[]> {
  const rows = (await sql`
    select id, score_id, factory, run_id, type, payload, created_at
    from score_events where score_id = ${scoreId} order by id asc
  `) as {
    id: number | string;
    score_id: string;
    factory: string;
    run_id: string;
    type: string;
    payload: unknown;
    created_at: unknown;
  }[];
  return rows.map((row) => ({
    id: Number(row.id),
    scoreId: row.score_id,
    factory: row.factory,
    runId: row.run_id,
    type: row.type,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  }));
}

export async function listScores(sql: SQL, filters: ScoreFilters = {}): Promise<ScoreRecord[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const factory = filters.factory ?? null;
  const runId = filters.runId ?? null;
  const workItemId = filters.workItemId ?? null;
  const stage = filters.stage ?? null;
  const scorer = filters.scorer ?? null;
  const since = filters.since ?? null;

  const rows = (await sql`
    select s.*,
           coalesce(
             jsonb_agg(jsonb_build_object('kind', e.kind, 'ref', e.ref, 'detail', e.detail))
               filter (where e.score_id is not null),
             '[]'::jsonb
           ) as evidence
    from scores s
    left join score_evidence e on e.score_id = s.id
    where (${factory}::text is null or s.factory = ${factory})
      and (${runId}::text is null or s.run_id = ${runId})
      and (${workItemId}::text is null or s.work_item_id = ${workItemId})
      and (${stage}::text is null or s.stage = ${stage})
      and (${scorer}::text is null or s.scorer = ${scorer})
      and (${since}::timestamptz is null or s.created_at >= ${since}::timestamptz)
    group by s.id
    order by s.created_at desc
    limit ${limit} offset ${offset}
  `) as ScoreRow[];

  return rows.map((row) => mapScore(row));
}

interface AggregateRow {
  scorer: string;
  scorer_class: string;
  samples: number | string;
  weighted_score: unknown;
  passing_count: number | string;
  error_count: number | string;
  skipped_count: number | string;
  uncalibrated_count: number | string;
  cost_usd: unknown;
}

/**
 * Aggregate pass rate per scorer, weighted by `score`, over the same filters. Returns
 * one row per scorer with sample counts; a scorer with no successful samples has
 * `passRate: null` rather than a fabricated zero.
 */
export async function aggregateScores(
  sql: SQL,
  filters: ScoreFilters = {},
): Promise<ScoreAggregate[]> {
  const factory = filters.factory ?? null;
  const runId = filters.runId ?? null;
  const workItemId = filters.workItemId ?? null;
  const stage = filters.stage ?? null;
  const scorer = filters.scorer ?? null;
  const since = filters.since ?? null;

  const rows = (await sql`
    select
      scorer,
      scorer_class,
      count(*) filter (where status = 'ok') as samples,
      avg(score) filter (where status = 'ok' and score is not null) as weighted_score,
      count(*) filter (where status = 'ok' and passing) as passing_count,
      count(*) filter (where status = 'error') as error_count,
      count(*) filter (where status = 'skipped') as skipped_count,
      count(*) filter (where status = 'ok' and uncalibrated) as uncalibrated_count,
      coalesce(sum(cost_usd), 0) as cost_usd
    from scores
    where (${factory}::text is null or factory = ${factory})
      and (${runId}::text is null or run_id = ${runId})
      and (${workItemId}::text is null or work_item_id = ${workItemId})
      and (${stage}::text is null or stage = ${stage})
      and (${scorer}::text is null or scorer = ${scorer})
      and (${since}::timestamptz is null or created_at >= ${since}::timestamptz)
    group by scorer, scorer_class
  `) as AggregateRow[];

  return rows
    .map((row) => {
      const samples = Number(row.samples);
      const passing = Number(row.passing_count);
      const uncalibrated = Number(row.uncalibrated_count);
      return {
        scorer: row.scorer,
        scorerClass: row.scorer_class as ScorerClass,
        sampleCount: samples,
        passingCount: passing,
        passRate: samples === 0 ? null : passing / samples,
        weightedScore: samples === 0 ? null : numOrZero(row.weighted_score),
        errorCount: Number(row.error_count),
        skippedCount: Number(row.skipped_count),
        uncalibratedCount: uncalibrated,
        costUsd: numOrZero(row.cost_usd),
        benchmarkEligible:
          row.scorer_class === 'deterministic'
            ? samples > 0
            : samples > 0 && uncalibrated === 0,
      } satisfies ScoreAggregate;
    })
    .sort((left, right) => left.scorer.localeCompare(right.scorer));
}

/** Judge scores consumed today (budget accounting). Skipped rows never consume budget. */
export async function countJudgeScoresToday(sql: SQL, factory: string): Promise<number> {
  const rows = (await sql`
    select count(*) as used
    from scores
    where factory = ${factory}
      and scorer_class = 'judge'
      and status in ('ok', 'error')
      and created_at >= date_trunc('day', now())
  `) as { used: number | string }[];
  return Number(rows[0]?.used ?? 0);
}

export async function latestScoreAt(
  sql: SQL,
  factory: string,
  scorer: string,
): Promise<string | null> {
  const rows = (await sql`
    select max(created_at) as latest
    from scores where factory = ${factory} and scorer = ${scorer}
  `) as { latest: unknown }[];
  return iso(rows[0]?.latest);
}

/* ----------------------------------------------------------- calibration */

interface CalibrationSetRow {
  id: string;
  factory: string;
  scorer: string;
  name: string;
  min_size: number | string;
  threshold: unknown;
  tolerance: unknown;
  created_at: unknown;
}

function mapCalibrationSet(row: CalibrationSetRow): CalibrationSetRecord {
  return {
    id: row.id,
    factory: row.factory,
    scorer: row.scorer,
    name: row.name,
    minSize: Number(row.min_size),
    threshold: numOrZero(row.threshold),
    tolerance: numOrZero(row.tolerance),
    createdAt: iso(row.created_at),
  };
}

export interface CreateCalibrationSetArgs {
  id: string;
  factory: string;
  scorer: string;
  name: string;
  minSize: number;
  threshold: number;
  tolerance: number;
}

export async function createCalibrationSet(
  sql: SQL,
  args: CreateCalibrationSetArgs,
): Promise<CalibrationSetRecord> {
  const rows = (await sql`
    insert into calibration_sets (id, factory, scorer, name, min_size, threshold, tolerance)
    values (${args.id}, ${args.factory}, ${args.scorer}, ${args.name},
            ${args.minSize}, ${args.threshold}, ${args.tolerance})
    returning *
  `) as CalibrationSetRow[];
  return mapCalibrationSet(rows[0] as CalibrationSetRow);
}

export async function listCalibrationSets(
  sql: SQL,
  args: { factory: string; scorer?: string | null },
): Promise<CalibrationSetRecord[]> {
  const scorer = args.scorer ?? null;
  const rows = (await sql`
    select * from calibration_sets
    where factory = ${args.factory}
      and (${scorer}::text is null or scorer = ${scorer})
    order by created_at desc
  `) as CalibrationSetRow[];
  return rows.map(mapCalibrationSet);
}

export async function getCalibrationSet(
  sql: SQL,
  id: string,
): Promise<CalibrationSetRecord | null> {
  const rows = (await sql`select * from calibration_sets where id = ${id} limit 1`) as CalibrationSetRow[];
  return rows[0] ? mapCalibrationSet(rows[0]) : null;
}

interface CalibrationItemRow {
  id: number | string;
  set_id: string;
  run_id: string | null;
  work_item_id: string | null;
  human_label: string;
  human_score: unknown;
  notes: string | null;
  created_at: unknown;
}

function mapCalibrationItem(row: CalibrationItemRow): CalibrationItemRecord {
  return {
    id: Number(row.id),
    setId: row.set_id,
    runId: row.run_id,
    workItemId: row.work_item_id,
    humanLabel: row.human_label,
    humanScore: numOrZero(row.human_score),
    notes: row.notes,
    createdAt: iso(row.created_at),
  };
}

export async function addCalibrationItem(
  sql: SQL,
  args: {
    setId: string;
    runId?: string | null;
    workItemId?: string | null;
    humanLabel: string;
    humanScore: number;
    notes?: string | null;
  },
): Promise<CalibrationItemRecord> {
  const rows = (await sql`
    insert into calibration_items (set_id, run_id, work_item_id, human_label, human_score, notes)
    values (${args.setId}, ${args.runId ?? null}, ${args.workItemId ?? null},
            ${args.humanLabel}, ${args.humanScore}, ${args.notes ?? null})
    returning *
  `) as CalibrationItemRow[];
  return mapCalibrationItem(rows[0] as CalibrationItemRow);
}

export async function listCalibrationItems(
  sql: SQL,
  setId: string,
): Promise<CalibrationItemRecord[]> {
  const rows = (await sql`
    select * from calibration_items where set_id = ${setId} order by id asc
  `) as CalibrationItemRow[];
  return rows.map(mapCalibrationItem);
}

interface CalibrationResultRow {
  id: number | string;
  set_id: string;
  factory: string;
  scorer: string;
  rubric_hash: string;
  judge_model: string;
  judge_model_version: string | null;
  sample_size: number | string;
  agreement_exact: unknown;
  agreement_within_tolerance: unknown;
  tolerance: unknown;
  threshold: unknown;
  confusion: unknown;
  verdict: string;
  created_at: unknown;
}

function mapCalibrationResult(row: CalibrationResultRow): CalibrationResultRecord {
  return {
    id: Number(row.id),
    setId: row.set_id,
    factory: row.factory,
    scorer: row.scorer,
    rubricHash: row.rubric_hash,
    judgeModel: row.judge_model,
    judgeModelVersion: row.judge_model_version,
    sampleSize: Number(row.sample_size),
    agreementExact: num(row.agreement_exact),
    agreementWithinTolerance: num(row.agreement_within_tolerance),
    tolerance: numOrZero(row.tolerance),
    threshold: numOrZero(row.threshold),
    confusion: parseJsonb<Record<string, Record<string, number>>>(row.confusion, {}),
    verdict: row.verdict as CalibrationVerdict,
    createdAt: iso(row.created_at),
  };
}

export interface RecordCalibrationResultArgs {
  setId: string;
  factory: string;
  scorer: string;
  rubricHash: string;
  judgeModel: string;
  judgeModelVersion?: string | null;
  sampleSize: number;
  agreementExact?: number | null;
  agreementWithinTolerance?: number | null;
  tolerance: number;
  threshold: number;
  confusion: Record<string, Record<string, number>>;
  verdict: CalibrationVerdict;
}

export async function recordCalibrationResult(
  sql: SQL,
  args: RecordCalibrationResultArgs,
): Promise<CalibrationResultRecord> {
  const rows = (await sql`
    insert into calibration_results (
      set_id, factory, scorer, rubric_hash, judge_model, judge_model_version, sample_size,
      agreement_exact, agreement_within_tolerance, tolerance, threshold, confusion, verdict
    ) values (
      ${args.setId}, ${args.factory}, ${args.scorer}, ${args.rubricHash}, ${args.judgeModel},
      ${args.judgeModelVersion ?? null}, ${args.sampleSize}, ${args.agreementExact ?? null},
      ${args.agreementWithinTolerance ?? null}, ${args.tolerance}, ${args.threshold},
      ${args.confusion}::jsonb, ${args.verdict}
    )
    returning *
  `) as CalibrationResultRow[];
  return mapCalibrationResult(rows[0] as CalibrationResultRow);
}

export async function listCalibrationResults(
  sql: SQL,
  args: { factory: string; scorer?: string | null; rubricHash?: string | null; limit?: number },
): Promise<CalibrationResultRecord[]> {
  const scorer = args.scorer ?? null;
  const rubricHash = args.rubricHash ?? null;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const rows = (await sql`
    select * from calibration_results
    where factory = ${args.factory}
      and (${scorer}::text is null or scorer = ${scorer})
      and (${rubricHash}::text is null or rubric_hash = ${rubricHash})
    order by created_at desc
    limit ${limit}
  `) as CalibrationResultRow[];
  return rows.map(mapCalibrationResult);
}

export async function latestCalibrationResult(
  sql: SQL,
  args: { factory: string; scorer: string; rubricHash: string; judgeModel: string },
): Promise<CalibrationResultRecord | null> {
  const rows = (await sql`
    select * from calibration_results
    where factory = ${args.factory}
      and scorer = ${args.scorer}
      and rubric_hash = ${args.rubricHash}
      and judge_model = ${args.judgeModel}
    order by created_at desc
    limit 1
  `) as CalibrationResultRow[];
  return rows[0] ? mapCalibrationResult(rows[0]) : null;
}
