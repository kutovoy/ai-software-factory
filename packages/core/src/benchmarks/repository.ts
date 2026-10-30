import type { SQL } from 'bun';
import type {
  BenchmarkAttestationRecord,
  BenchmarkEventRecord,
  BenchmarkResultRecord,
  BenchmarkRunRecord,
  BenchmarkRunStatus,
  BenchmarkTrialRecord,
  BenchmarkTrialStatus,
} from './types';

/**
 * Benchmark repository (ADR-010: plain SQL, explicit `SQL` handle).
 *
 * Idempotency: a benchmark run is keyed by its id; a trial is upserted on
 * `(benchmark_run_id, configuration, task)`; results on `(benchmark_run_id, configuration)`;
 * an attestation on `(factory, definition_commit, config_hash)`; events on
 * `(benchmark_run_id, type)`. A Temporal retry therefore never writes a duplicate.
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

/* ---------------------------------------------------------------- run rows */

interface BenchmarkRunRow {
  id: string;
  factory: string;
  suite: string;
  definition_commit: string;
  config_hash: string;
  status: string;
  tasks: unknown;
  configurations: unknown;
  matrix: unknown;
  estimate_usd: unknown;
  max_cost_usd: unknown;
  spent_usd: unknown;
  budget_exhausted: boolean;
  partial: boolean;
  pass_rate: unknown;
  calibration_ok: boolean;
  passed: boolean;
  error: string | null;
  workflow_id: string | null;
  temporal_run_id: string | null;
  started_at: unknown;
  ended_at: unknown;
}

function mapRun(row: BenchmarkRunRow): BenchmarkRunRecord {
  return {
    id: row.id,
    factory: row.factory,
    suite: row.suite,
    definitionCommit: row.definition_commit,
    configHash: row.config_hash,
    status: row.status as BenchmarkRunStatus,
    tasks: parseJsonb<string[]>(row.tasks, []),
    configurations: parseJsonb<string[]>(row.configurations, []),
    matrix: parseJsonb<{ configuration: string; task: string }[]>(row.matrix, []),
    estimateUsd: num(row.estimate_usd),
    maxCostUsd: numOrZero(row.max_cost_usd),
    spentUsd: numOrZero(row.spent_usd),
    budgetExhausted: row.budget_exhausted,
    partial: row.partial,
    passRate: num(row.pass_rate),
    calibrationOk: row.calibration_ok,
    passed: row.passed,
    error: row.error,
    workflowId: row.workflow_id,
    temporalRunId: row.temporal_run_id,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

export interface CreateBenchmarkRunArgs {
  id: string;
  factory: string;
  suite: string;
  definitionCommit: string;
  configHash: string;
  tasks: string[];
  configurations: string[];
  matrix: { configuration: string; task: string }[];
  estimateUsd?: number | null;
  maxCostUsd: number;
  partial: boolean;
  workflowId?: string | null;
  temporalRunId?: string | null;
}

export async function createBenchmarkRun(
  sql: SQL,
  args: CreateBenchmarkRunArgs,
): Promise<BenchmarkRunRecord> {
  await sql`
    insert into benchmark_runs (
      id, factory, suite, definition_commit, config_hash, status, tasks, configurations,
      matrix, estimate_usd, max_cost_usd, partial, workflow_id, temporal_run_id, started_at
    ) values (
      ${args.id}, ${args.factory}, ${args.suite}, ${args.definitionCommit}, ${args.configHash},
      'queued', ${args.tasks}::jsonb, ${args.configurations}::jsonb,
      ${args.matrix}::jsonb, ${args.estimateUsd ?? null}, ${args.maxCostUsd},
      ${args.partial}, ${args.workflowId ?? null}, ${args.temporalRunId ?? null}, now()
    )
    on conflict (id) do nothing
  `;
  const rows = (await sql`select * from benchmark_runs where id = ${args.id} limit 1`) as BenchmarkRunRow[];
  return mapRun(rows[0] as BenchmarkRunRow);
}

export async function getBenchmarkRun(
  sql: SQL,
  id: string,
): Promise<BenchmarkRunRecord | null> {
  const rows = (await sql`select * from benchmark_runs where id = ${id} limit 1`) as BenchmarkRunRow[];
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listBenchmarkRuns(
  sql: SQL,
  args: { factory?: string | null; limit?: number } = {},
): Promise<BenchmarkRunRecord[]> {
  const factory = args.factory ?? null;
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const rows = (await sql`
    select * from benchmark_runs
    where (${factory}::text is null or factory = ${factory})
    order by started_at desc
    limit ${limit}
  `) as BenchmarkRunRow[];
  return rows.map(mapRun);
}

export async function markBenchmarkRunning(
  sql: SQL,
  args: { id: string; workflowId?: string | null; temporalRunId?: string | null },
): Promise<BenchmarkRunRecord> {
  const rows = (await sql`
    update benchmark_runs set
      status = case when status = 'queued' then 'running' else status end,
      workflow_id = coalesce(${args.workflowId ?? null}, workflow_id),
      temporal_run_id = coalesce(${args.temporalRunId ?? null}, temporal_run_id),
      started_at = coalesce(started_at, now())
    where id = ${args.id}
    returning *
  `) as BenchmarkRunRow[];
  return mapRun(rows[0] as BenchmarkRunRow);
}

export async function finishBenchmarkRun(
  sql: SQL,
  args: {
    id: string;
    status: 'completed' | 'error' | 'cancelled';
    spentUsd: number;
    budgetExhausted: boolean;
    passRate?: number | null;
    calibrationOk?: boolean;
    passed?: boolean;
    error?: string | null;
  },
): Promise<BenchmarkRunRecord> {
  const rows = (await sql`
    update benchmark_runs set
      status = ${args.status},
      spent_usd = ${args.spentUsd},
      budget_exhausted = ${args.budgetExhausted},
      pass_rate = ${args.passRate ?? null},
      calibration_ok = ${args.calibrationOk ?? false},
      passed = ${args.passed ?? false},
      error = ${args.error ?? null},
      ended_at = coalesce(ended_at, now())
    where id = ${args.id}
    returning *
  `) as BenchmarkRunRow[];
  return mapRun(rows[0] as BenchmarkRunRow);
}

/* -------------------------------------------------------------- trial rows */

interface BenchmarkTrialRow {
  id: string;
  benchmark_run_id: string;
  factory: string;
  suite: string;
  configuration: string;
  task: string;
  run_id: string | null;
  status: string;
  error_code: string | null;
  score: unknown;
  passing: boolean;
  cost_usd: unknown;
  uncalibrated: boolean;
  starting_repo_refs: unknown;
  repo: string | null;
  definition_commit: string;
  config_hash: string;
  started_at: unknown;
  ended_at: unknown;
}

function mapTrial(row: BenchmarkTrialRow): BenchmarkTrialRecord {
  return {
    id: row.id,
    benchmarkRunId: row.benchmark_run_id,
    factory: row.factory,
    suite: row.suite,
    configuration: row.configuration,
    task: row.task,
    runId: row.run_id,
    status: row.status as BenchmarkTrialStatus,
    errorCode: row.error_code,
    score: num(row.score),
    passing: row.passing,
    costUsd: numOrZero(row.cost_usd),
    uncalibrated: row.uncalibrated,
    startingRepoRefs: parseJsonb<string[]>(row.starting_repo_refs, []),
    repo: row.repo,
    definitionCommit: row.definition_commit,
    configHash: row.config_hash,
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
  };
}

export interface RecordBenchmarkTrialArgs {
  id: string;
  benchmarkRunId: string;
  factory: string;
  suite: string;
  configuration: string;
  task: string;
  runId?: string | null;
  status: BenchmarkTrialStatus;
  errorCode?: string | null;
  score?: number | null;
  passing?: boolean;
  costUsd?: number;
  uncalibrated?: boolean;
  startingRepoRefs?: string[];
  repo?: string | null;
  definitionCommit: string;
  configHash: string;
  startedAt?: string | null;
  endedAt?: string | null;
}

/** Upserts one trial on `(benchmark_run_id, configuration, task)`. */
export async function recordBenchmarkTrial(
  sql: SQL,
  args: RecordBenchmarkTrialArgs,
): Promise<BenchmarkTrialRecord> {
  const rows = (await sql`
    insert into benchmark_trials (
      id, benchmark_run_id, factory, suite, configuration, task, run_id, status,
      error_code, score, passing, cost_usd, uncalibrated, starting_repo_refs, repo,
      definition_commit, config_hash, started_at, ended_at
    ) values (
      ${args.id}, ${args.benchmarkRunId}, ${args.factory}, ${args.suite}, ${args.configuration},
      ${args.task}, ${args.runId ?? null}, ${args.status}, ${args.errorCode ?? null},
      ${args.score ?? null}, ${args.passing ?? false}, ${args.costUsd ?? 0},
      ${args.uncalibrated ?? false}, ${(args.startingRepoRefs ?? [])}::jsonb,
      ${args.repo ?? null}, ${args.definitionCommit}, ${args.configHash},
      ${args.startedAt ?? new Date().toISOString()}::timestamptz,
      ${args.endedAt ?? null}::timestamptz
    )
    on conflict (benchmark_run_id, configuration, task) do update set
      id = excluded.id,
      run_id = coalesce(excluded.run_id, benchmark_trials.run_id),
      status = excluded.status,
      error_code = excluded.error_code,
      score = excluded.score,
      passing = excluded.passing,
      cost_usd = excluded.cost_usd,
      uncalibrated = excluded.uncalibrated,
      starting_repo_refs = excluded.starting_repo_refs,
      repo = coalesce(excluded.repo, benchmark_trials.repo),
      definition_commit = excluded.definition_commit,
      config_hash = excluded.config_hash,
      started_at = benchmark_trials.started_at,
      ended_at = excluded.ended_at
    returning *
  `) as BenchmarkTrialRow[];
  return mapTrial(rows[0] as BenchmarkTrialRow);
}

export async function listBenchmarkTrials(
  sql: SQL,
  benchmarkRunId: string,
): Promise<BenchmarkTrialRecord[]> {
  const rows = (await sql`
    select * from benchmark_trials
    where benchmark_run_id = ${benchmarkRunId}
    order by configuration asc, task asc
  `) as BenchmarkTrialRow[];
  return rows.map(mapTrial);
}

export async function getBenchmarkTrial(
  sql: SQL,
  args: { benchmarkRunId: string; configuration: string; task: string },
): Promise<BenchmarkTrialRecord | null> {
  const rows = (await sql`
    select * from benchmark_trials
    where benchmark_run_id = ${args.benchmarkRunId}
      and configuration = ${args.configuration}
      and task = ${args.task}
    limit 1
  `) as BenchmarkTrialRow[];
  return rows[0] ? mapTrial(rows[0]) : null;
}

/* ------------------------------------------------------------- result rows */

interface BenchmarkResultRow {
  benchmark_run_id: string;
  configuration: string;
  pass_rate: unknown;
  weighted_score: unknown;
  sample_size: number | string;
  passing_count: number | string;
  cost_usd: unknown;
  errors: number | string;
  skipped: number | string;
  uncalibrated: boolean;
  labels: unknown;
  frontier: boolean;
  dominated_by: string | null;
}

function mapResult(row: BenchmarkResultRow): BenchmarkResultRecord {
  return {
    benchmarkRunId: row.benchmark_run_id,
    configuration: row.configuration,
    passRate: num(row.pass_rate),
    weightedScore: num(row.weighted_score),
    sampleSize: Number(row.sample_size),
    passingCount: Number(row.passing_count),
    costUsd: numOrZero(row.cost_usd),
    errors: Number(row.errors),
    skipped: Number(row.skipped),
    uncalibrated: row.uncalibrated,
    labels: parseJsonb<string[]>(row.labels, []),
    frontier: row.frontier,
    dominatedBy: row.dominated_by,
  };
}

export interface UpsertBenchmarkResultArgs {
  benchmarkRunId: string;
  configuration: string;
  passRate: number | null;
  weightedScore: number | null;
  sampleSize: number;
  passingCount: number;
  costUsd: number;
  errors: number;
  skipped: number;
  uncalibrated: boolean;
  labels: string[];
  frontier: boolean;
  dominatedBy?: string | null;
}

export async function upsertBenchmarkResult(
  sql: SQL,
  args: UpsertBenchmarkResultArgs,
): Promise<BenchmarkResultRecord> {
  const rows = (await sql`
    insert into benchmark_results (
      benchmark_run_id, configuration, pass_rate, weighted_score, sample_size, passing_count,
      cost_usd, errors, skipped, uncalibrated, labels, frontier, dominated_by
    ) values (
      ${args.benchmarkRunId}, ${args.configuration}, ${args.passRate ?? null},
      ${args.weightedScore ?? null}, ${args.sampleSize}, ${args.passingCount}, ${args.costUsd},
      ${args.errors}, ${args.skipped}, ${args.uncalibrated}, ${args.labels}::jsonb,
      ${args.frontier}, ${args.dominatedBy ?? null}
    )
    on conflict (benchmark_run_id, configuration) do update set
      pass_rate = excluded.pass_rate,
      weighted_score = excluded.weighted_score,
      sample_size = excluded.sample_size,
      passing_count = excluded.passing_count,
      cost_usd = excluded.cost_usd,
      errors = excluded.errors,
      skipped = excluded.skipped,
      uncalibrated = excluded.uncalibrated,
      labels = excluded.labels,
      frontier = excluded.frontier,
      dominated_by = excluded.dominated_by
    returning *
  `) as BenchmarkResultRow[];
  return mapResult(rows[0] as BenchmarkResultRow);
}

export async function listBenchmarkResults(
  sql: SQL,
  benchmarkRunId: string,
): Promise<BenchmarkResultRecord[]> {
  const rows = (await sql`
    select * from benchmark_results
    where benchmark_run_id = ${benchmarkRunId}
    order by configuration asc
  `) as BenchmarkResultRow[];
  return rows.map(mapResult);
}

/* --------------------------------------------------------- attestation rows */

interface BenchmarkAttestationRow {
  id: string;
  factory: string;
  definition_commit: string;
  suite: string;
  config_hash: string;
  pass_rate: unknown;
  calibration_ok: boolean;
  passed: boolean;
  partial: boolean;
  benchmark_run_id: string | null;
  created_at: unknown;
}

function mapAttestation(row: BenchmarkAttestationRow): BenchmarkAttestationRecord {
  return {
    id: row.id,
    factory: row.factory,
    definitionCommit: row.definition_commit,
    suite: row.suite,
    configHash: row.config_hash,
    passRate: num(row.pass_rate),
    calibrationOk: row.calibration_ok,
    passed: row.passed,
    partial: row.partial,
    benchmarkRunId: row.benchmark_run_id,
    createdAt: iso(row.created_at),
  };
}

export interface RecordBenchmarkAttestationArgs {
  id: string;
  factory: string;
  definitionCommit: string;
  suite: string;
  configHash: string;
  passRate: number | null;
  calibrationOk: boolean;
  passed: boolean;
  partial?: boolean;
  benchmarkRunId?: string | null;
}

/** Upserts the attestation for `(factory, definition_commit, config_hash)`. */
export async function recordBenchmarkAttestation(
  sql: SQL,
  args: RecordBenchmarkAttestationArgs,
): Promise<BenchmarkAttestationRecord> {
  const rows = (await sql`
    insert into benchmark_attestations (
      id, factory, definition_commit, suite, config_hash, pass_rate, calibration_ok, passed,
      partial, benchmark_run_id, created_at
    ) values (
      ${args.id}, ${args.factory}, ${args.definitionCommit}, ${args.suite}, ${args.configHash},
      ${args.passRate ?? null}, ${args.calibrationOk}, ${args.passed},
      ${args.partial ?? false}, ${args.benchmarkRunId ?? null}, now()
    )
    on conflict (factory, definition_commit, config_hash) do update set
      suite = excluded.suite,
      pass_rate = excluded.pass_rate,
      calibration_ok = excluded.calibration_ok,
      passed = excluded.passed,
      partial = excluded.partial,
      benchmark_run_id = excluded.benchmark_run_id,
      created_at = now()
    returning *
  `) as BenchmarkAttestationRow[];
  return mapAttestation(rows[0] as BenchmarkAttestationRow);
}

export async function findBenchmarkAttestation(
  sql: SQL,
  args: { factory: string; definitionCommit: string; configHash: string },
): Promise<BenchmarkAttestationRecord | null> {
  const rows = (await sql`
    select * from benchmark_attestations
    where factory = ${args.factory}
      and definition_commit = ${args.definitionCommit}
      and config_hash = ${args.configHash}
    limit 1
  `) as BenchmarkAttestationRow[];
  return rows[0] ? mapAttestation(rows[0]) : null;
}

export async function listBenchmarkAttestations(
  sql: SQL,
  args: { factory: string; limit?: number },
): Promise<BenchmarkAttestationRecord[]> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
  const rows = (await sql`
    select * from benchmark_attestations
    where factory = ${args.factory}
    order by created_at desc
    limit ${limit}
  `) as BenchmarkAttestationRow[];
  return rows.map(mapAttestation);
}

/* -------------------------------------------------------------- event rows */

interface BenchmarkEventRow {
  id: number | string;
  benchmark_run_id: string;
  factory: string;
  type: string;
  payload: unknown;
  created_at: unknown;
}

function mapEvent(row: BenchmarkEventRow): BenchmarkEventRecord {
  return {
    id: Number(row.id),
    benchmarkRunId: row.benchmark_run_id,
    factory: row.factory,
    type: row.type,
    payload: parseJsonb<Record<string, unknown>>(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

/** Appends one deduped benchmark event. Returns `appended: false` on a retry. */
export async function recordBenchmarkEvent(
  sql: SQL,
  args: {
    benchmarkRunId: string;
    factory: string;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ appended: boolean; event: BenchmarkEventRecord }> {
  const inserted = (await sql`
    insert into benchmark_events (benchmark_run_id, factory, type, payload)
    values (${args.benchmarkRunId}, ${args.factory}, ${args.type},
            ${(args.payload ?? {})}::jsonb)
    on conflict (benchmark_run_id, type) do nothing
    returning *
  `) as BenchmarkEventRow[];

  if (inserted[0]) return { appended: true, event: mapEvent(inserted[0]) };

  const existing = (await sql`
    select * from benchmark_events
    where benchmark_run_id = ${args.benchmarkRunId} and type = ${args.type}
    limit 1
  `) as BenchmarkEventRow[];
  return { appended: false, event: mapEvent(existing[0] as BenchmarkEventRow) };
}

export async function listBenchmarkEvents(
  sql: SQL,
  benchmarkRunId: string,
): Promise<BenchmarkEventRecord[]> {
  const rows = (await sql`
    select * from benchmark_events
    where benchmark_run_id = ${benchmarkRunId}
    order by id asc
  `) as BenchmarkEventRow[];
  return rows.map(mapEvent);
}

/* ------------------------------------------------------- comparable run costs */

/**
 * Costs of recent comparable runs (same factory, terminal, cost attributed). Used by the
 * estimator as the empirical median; an empty list means "no comparable data" and the
 * caller falls back to a configured per-run cost rather than inventing a number.
 */
export async function comparableRunCosts(
  sql: SQL,
  args: { factory: string; limit?: number },
): Promise<number[]> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const rows = (await sql`
    select cost_usd from runs
    where factory = ${args.factory}
      and status in ('ok', 'error', 'cancelled')
      and cost_usd is not null
    order by started_at desc
    limit ${limit}
  `) as { cost_usd: unknown }[];
  return rows.map((row) => numOrZero(row.cost_usd));
}
