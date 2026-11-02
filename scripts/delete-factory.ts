#!/usr/bin/env bun
/**
 * Delete a factory: purge its application state through the API, then remove its
 * definition directory from git.
 *
 *   bun scripts/delete-factory.ts <factory_id | legacy-name | owner/name> [--yes] [--force] [--dry-run]
 *
 * The API owns the purge (change `fix-factory-purge`, spec `factory-purge`): one
 * transaction over every factory-scoped table, Temporal schedule deletion, running
 * workflow termination and `runs/<id>/` removal. This script only authenticates, asks the
 * API, removes the definition directory and prints the commit reminder.
 *
 * It never talks to Postgres or Temporal directly, and it never silently skips them: a
 * database/Temporal outage makes the API answer `503` and the script exits non-zero.
 * Git history and the forge repository/PRs are kept.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positionals = args.filter((arg) => !arg.startsWith('--'));
const identifier = positionals[0];

const yes = flags.has('--yes');
const force = flags.has('--force');
const dryRun = flags.has('--dry-run');

const USAGE =
  'usage: bun scripts/delete-factory.ts <factory_id | legacy-name | owner/name> [--yes] [--force] [--dry-run]';

if (!identifier) {
  console.error(USAGE);
  process.exit(1);
}

/** `API_BASE_URL` may be an origin or the versioned base; both are accepted. */
function apiBase(): string {
  const raw = (process.env.API_BASE_URL ?? 'http://localhost:8080/api/v1').replace(/\/+$/, '');
  return /\/api\/v1$/.test(raw) ? raw : `${raw}/api/v1`;
}

const API = apiBase();
const FACTORY_ROOT = resolve(process.env.FACTORY_ROOT ?? './factories');
const ADMIN_EMAIL = process.env.FACTORY_ADMIN_EMAIL ?? 'admin@factory.local';
const ADMIN_PASSWORD = process.env.FACTORY_ADMIN_PASSWORD ?? 'factory-admin';

interface FactoryListEntry {
  id: string | null;
  key: string;
  name: string;
  path: string;
  owner: string | null;
}

interface PurgeReport {
  factoryId: string;
  factory: string;
  dryRun: boolean;
  deleted?: { tables: Record<string, number>; rows: number };
  schedules?: string[];
  workflows?: string[];
  runDirs?: string[];
  failures?: Array<{ step: string; id: string; error: string }>;
  activeWork?: { workItems: number; runs: number };
  forceRequired?: boolean;
  plan?: {
    tables: Record<string, number>;
    rows: number;
    schedules: string[];
    workflows: string[];
    runDirs: string[];
  };
}

function fail(message: string, code = 1): never {
  console.error(`\nerror: ${message}`);
  process.exit(code);
}

/** Extracts the `factory_session` cookie from a login response. */
function sessionCookie(response: Response): string | null {
  const headers = response.headers as unknown as { getSetCookie?: () => string[] };
  const lines = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  for (const line of lines) {
    const match = /factory_session=([^;]*)/.exec(line);
    if (match?.[1]) return `factory_session=${match[1]}`;
  }
  return null;
}

async function request(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const { cookie, ...rest } = init;
  return await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      accept: 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { code?: string; message?: string };
    return body.code ? `${body.code}: ${body.message ?? text}` : text;
  } catch {
    return text;
  }
}

async function login(): Promise<string> {
  let response: Response;
  try {
    response = await request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
  } catch (error) {
    fail(
      `cannot reach the API at ${API} (${(error as Error).message}). ` +
        'Set API_BASE_URL to the running API and try again.',
    );
  }

  if (!response.ok) {
    fail(
      `login failed (${response.status}) as ${ADMIN_EMAIL}: ${await errorText(response)}. ` +
        'Set FACTORY_ADMIN_EMAIL / FACTORY_ADMIN_PASSWORD to an existing admin account.',
    );
  }

  const cookie = sessionCookie(response);
  if (!cookie) fail('login succeeded but the API returned no `factory_session` cookie');
  return cookie;
}

function findFactory(factories: FactoryListEntry[], wanted: string): FactoryListEntry {
  const byId = factories.find((factory) => factory.id === wanted);
  if (byId) return byId;

  const byKey = factories.find((factory) => factory.key === wanted || factory.path === wanted);
  if (byKey) return byKey;

  const byName = factories.filter((factory) => factory.name === wanted);
  if (byName.length === 1) return byName[0] as FactoryListEntry;
  if (byName.length > 1) {
    fail(
      `"${wanted}" is ambiguous; use the factory id or the owner-scoped key:\n` +
        byName.map((factory) => `  ${factory.id ?? '(no id)'}  ${factory.key}`).join('\n'),
      1,
    );
  }

  const visible = factories
    .map((factory) => `  ${factory.id ?? '(no id)'}  ${factory.key}`)
    .join('\n');
  fail(`no factory "${wanted}" is visible to ${ADMIN_EMAIL}. Visible factories:\n${visible || '  (none)'}`);
}

function factoryDir(path: string): string {
  const dir = resolve(FACTORY_ROOT, ...path.split('/'));
  if (dir !== FACTORY_ROOT && !dir.startsWith(`${FACTORY_ROOT}${sep}`)) {
    fail(`refusing to remove "${dir}": it is outside FACTORY_ROOT (${FACTORY_ROOT})`);
  }
  return dir;
}

function printPlan(entry: FactoryListEntry, dir: string): void {
  console.log('Delete factory — plan\n');
  console.log(`  identifier: ${identifier}`);
  console.log(`  factory id: ${entry.id ?? '(missing — run the identity migration)'}`);
  console.log(`  key:        ${entry.key}`);
  console.log(`  directory:  ${dir}${existsSync(dir) ? '' : ' (already absent)'}`);
  console.log(`  api:        ${API}`);
  console.log(`  database:   purged by the API (fails closed if unreachable)`);
  console.log(`  temporal:   schedules deleted, running workflows terminated`);
  console.log(`  artifacts:  runs/<id>/ directories removed`);
  console.log(`  kept:       git history, forge repository and pull requests`);
  console.log(`  mode:       ${dryRun ? 'dry run (nothing is deleted)' : force ? 'force' : 'normal'}`);
}

function printReport(report: PurgeReport): void {
  if (report.dryRun) {
    console.log('\nDry run — nothing was deleted. A real purge would remove:');
    const plan = report.plan;
    if (!plan) return;
    console.log(`  rows:       ${plan.rows} across ${Object.keys(plan.tables).length} table(s)`);
    for (const [table, count] of Object.entries(plan.tables)) {
      if (count > 0) console.log(`    ${table}: ${count}`);
    }
    console.log(`  schedules:  ${plan.schedules.length}`);
    console.log(`  workflows:  ${plan.workflows.length}`);
    console.log(`  run dirs:   ${plan.runDirs.length}`);
    if (report.forceRequired) {
      console.log(
        `\n  active work: ${report.activeWork?.workItems ?? 0} item(s), ${report.activeWork?.runs ?? 0} run(s) — a real purge needs --force.`,
      );
    }
    return;
  }

  const deleted = report.deleted;
  console.log(`\nPurge report for ${report.factory} (${report.factoryId})`);
  console.log(`  rows deleted: ${deleted?.rows ?? 0} across ${Object.keys(deleted?.tables ?? {}).length} table(s)`);
  for (const [table, count] of Object.entries(deleted?.tables ?? {})) {
    if (count > 0) console.log(`    ${table}: ${count}`);
  }
  console.log(`  schedules deleted:    ${report.schedules?.length ?? 0}`);
  for (const id of report.schedules ?? []) console.log(`    ${id}`);
  console.log(`  workflows terminated: ${report.workflows?.length ?? 0}`);
  for (const id of report.workflows ?? []) console.log(`    ${id}`);
  console.log(`  run dirs removed:     ${report.runDirs?.length ?? 0}`);
  for (const dir of report.runDirs ?? []) console.log(`    ${dir}`);

  if ((report.failures ?? []).length > 0) {
    console.warn('\nwarning: some Temporal/artifact steps failed (the DB purge committed):');
    for (const failure of report.failures ?? []) {
      console.warn(`  ${failure.step} ${failure.id}: ${failure.error}`);
    }
  }
  console.log('\n  note: closed Temporal histories remain until retention; git history and forge PRs are kept.');
}

/* ---------------------------------------------------------------- run */

const cookie = await login();

let response: Response;
try {
  response = await request('/factories', { cookie });
} catch (error) {
  fail(`cannot list factories at ${API} (${(error as Error).message})`);
}
if (!response.ok) {
  fail(`GET /factories failed (${response.status}): ${await errorText(response)}`);
}
const listed = (await response.json()) as { factories?: FactoryListEntry[] };
const entry = findFactory(listed.factories ?? [], identifier);
const dir = factoryDir(entry.path);

printPlan(entry, dir);

if (!yes && !dryRun) {
  console.log('\nRe-run with --yes to proceed (or --dry-run to preview).');
  process.exit(2);
}

const query = new URLSearchParams();
if (force) query.set('force', '1');
if (dryRun) query.set('dryRun', '1');
const suffix = query.toString() ? `?${query}` : '';

try {
  response = await request(`/factories/${encodeURIComponent(entry.id ?? entry.key)}${suffix}`, {
    method: 'DELETE',
    cookie,
  });
} catch (error) {
  fail(`DELETE failed to reach ${API} (${(error as Error).message}); nothing was deleted`);
}

if (response.status === 409) {
  console.error(`\nrefusing: ${await errorText(response)}`);
  console.error('Cancel/retry the active work, or re-run with --force.');
  process.exit(3);
}
if (response.status === 503) {
  fail(
    `${await errorText(response)}\nNothing was deleted. Start the database/Temporal stack and retry.`,
    4,
  );
}
if (!response.ok) {
  fail(`purge failed (${response.status}): ${await errorText(response)}`, 4);
}

printReport((await response.json()) as PurgeReport);

if (dryRun) {
  console.log('\nDry run complete; the definition directory was not touched.');
  process.exit(0);
}

if (existsSync(dir)) {
  await rm(dir, { recursive: true, force: true });
  console.log(`\ndefinition directory removed: ${dir}`);
} else {
  console.log('\ndefinition directory already absent');
}

console.log(
  '\nCommit the removal:\n' +
    `  git add -A && git commit -m "chore: remove factory ${entry.key}"\n` +
    '\nGit history and the forge repository/PRs were kept.',
);
