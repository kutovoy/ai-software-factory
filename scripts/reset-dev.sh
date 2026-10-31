#!/usr/bin/env bash
# Explicit dev-data cleanup (ADR-029).
#
#   bash scripts/reset-dev.sh            # prints what it would delete, changes nothing
#   bash scripts/reset-dev.sh --yes      # deletes smoke/e2e/demo rows
#
# Removes rows created by `scripts/smoke.sh`, the Playwright suite and the demo factories:
# smoke/e2e runs and work items, benchmark runs, improvement proposals/lessons, canary
# rollouts, merge batches, automation schedules, demo integrations/MCP registrations and
# `SMOKE_*` secrets. Definitions stay in git and the factory index is untouched.
#
# The database is printed first so an operator can see exactly what is targeted. It
# refuses to run without `--yes`: this is not part of any automated path.

set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="${DATABASE_URL:-postgres://factory:factory@localhost:5433/factory}"
YES=0
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    *)
      printf '[reset-dev] unknown argument: %s (usage: reset-dev.sh [--yes])\n' "$arg" >&2
      exit 2
      ;;
  esac
done

printf '[reset-dev] database: %s\n' "$DATABASE_URL"
printf '[reset-dev] demo factories: example, example-lights-off\n'

if [ "$YES" != "1" ]; then
  cat <<'TXT'
[reset-dev] dry run: nothing was deleted.
[reset-dev] re-run with --yes to remove smoke/e2e/demo rows from this database.
TXT
  exit 2
fi

DATABASE_URL="$DATABASE_URL" bun - <<'BUN'
const { SQL } = await import('bun');

const sql = new SQL(process.env.DATABASE_URL, { max: 1 });

const counts = async () => {
  const q = async (query) => {
    const rows = await query;
    return Number(rows[0]?.count ?? 0);
  };
  return {
    runs: await q(sql`select count(*) from runs where coalesce(title, '') ilike 'smoke:%' or coalesce(title, '') ilike 'e2e:%' or coalesce(input->'prompt'->>'text', '') ilike 'smoke:%' or coalesce(input->'prompt'->>'text', '') ilike 'e2e:%'`),
    workItems: await q(sql`select count(*) from work_items where title ilike 'smoke:%' or title ilike 'e2e:%' or (source = 'cron' and factory in ('example', 'example-lights-off'))`),
    benchmarkRuns: await q(sql`select count(*) from benchmark_runs where factory in ('example', 'example-lights-off')`),
    improvementRuns: await q(sql`select count(*) from improvement_runs where factory in ('example', 'example-lights-off')`),
    proposals: await q(sql`select count(*) from proposals where factory in ('example', 'example-lights-off')`),
    canaryRollouts: await q(sql`select count(*) from canary_rollouts where factory in ('example', 'example-lights-off')`),
    mergeBatches: await q(sql`select count(*) from merge_batches where factory in ('example', 'example-lights-off')`),
    automationSchedules: await q(sql`select count(*) from automation_schedules where factory in ('example', 'example-lights-off')`),
    smokeSecrets: await q(sql`select count(*) from secrets where name like 'SMOKE%'`),
  };
};

console.log('[reset-dev] rows to delete:', JSON.stringify(await counts()));

await sql.begin(async (tx) => {
  // Child rows follow their parents through ON DELETE CASCADE. Order is parent-last where
  // an FK is SET NULL, so nothing is orphaned.
  await tx`delete from work_items where title ilike 'smoke:%' or title ilike 'e2e:%' or (source = 'cron' and factory in ('example', 'example-lights-off'))`;
  await tx`delete from runs where coalesce(title, '') ilike 'smoke:%' or coalesce(title, '') ilike 'e2e:%' or coalesce(input->'prompt'->>'text', '') ilike 'smoke:%' or coalesce(input->'prompt'->>'text', '') ilike 'e2e:%'`;

  await tx`delete from benchmark_attestations where factory in ('example', 'example-lights-off')`;
  await tx`delete from benchmark_runs where factory in ('example', 'example-lights-off')`;

  await tx`delete from lessons where factory in ('example', 'example-lights-off') or origin_factory in ('example', 'example-lights-off')`;
  await tx`delete from proposals where factory in ('example', 'example-lights-off')`;
  await tx`delete from improvement_runs where factory in ('example', 'example-lights-off')`;
  await tx`delete from canary_rollouts where factory in ('example', 'example-lights-off')`;

  await tx`delete from merge_batches where factory in ('example', 'example-lights-off')`;
  await tx`delete from automation_fires where factory in ('example', 'example-lights-off')`;
  await tx`delete from automation_schedules where factory in ('example', 'example-lights-off')`;
  await tx`delete from integrations where factory in ('example', 'example-lights-off')`;
  await tx`delete from mcp_tests where factory in ('example', 'example-lights-off')`;
  await tx`delete from mcp_bindings where factory in ('example', 'example-lights-off')`;
  await tx`delete from mcp_servers where factory in ('example', 'example-lights-off')`;
  await tx`delete from autonomy_state where factory in ('example', 'example-lights-off')`;
  await tx`delete from webhook_deliveries where factory in ('example', 'example-lights-off')`;

  await tx`delete from run_secrets where secret_name like 'SMOKE%'`;
  await tx`delete from secret_usage where secret_name like 'SMOKE%'`;
  await tx`delete from secrets where name like 'SMOKE%'`;
});

console.log('[reset-dev] rows after cleanup:', JSON.stringify(await counts()));
await sql.close();
BUN

printf '[reset-dev] done. Definitions in git and the factory index were not touched.\n'
