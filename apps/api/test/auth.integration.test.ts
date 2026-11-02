import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  createUser,
  findUserByEmail,
  listUsers,
  type User,
} from '@factory/core';
import { closeClient, getSql, insertRun, type RunInput } from '@factory/orchestration';
import { req, v1 } from './helpers';
import { createApp } from '../src/app';
import { ensureBootstrapAdmin } from '../src/auth';
import { loadApiConfig, type ApiConfig } from '../src/config';

/**
 * API auth integration (change `add-console-auth`, tasks 4.1).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory_test \
 *   TEMPORAL_ADDRESS=localhost:7233 RUN_INTEGRATION=1 \
 *   bun test apps/api/test/auth.integration.test.ts
 *
 * Covers login/logout/me, the enforcement switch, admin-only user management, and the
 * per-user scope on work items and runs.
 */

const enabled =
  process.env.RUN_INTEGRATION === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.TEMPORAL_ADDRESS);

const suite = enabled ? describe : describe.skip;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages', 'core', 'migrations');
const PREFIX = `itest-auth-api-${process.pid}`;

const ADMIN_EMAIL = `${PREFIX}-admin@factory.local`;
const ADMIN_PASSWORD = 'itest-admin-pass';
const MEMBER_EMAIL = `${PREFIX}-member@factory.local`;
const MEMBER_PASSWORD = 'itest-member-pass';

let config: ApiConfig;
let app: Hono;
let authOffApp: Hono;
let sql: SQL;
let admin: User;
let member: User;
const createdWorkItems: string[] = [];

async function migrate(databaseUrl: string): Promise<void> {
  const runner = new SQL(databaseUrl, { max: 1 });
  try {
    await runner`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = new Set(
      ((await runner`select name from schema_migrations`) as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(MIGRATIONS)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await runner.unsafe(await readFile(join(MIGRATIONS, file), 'utf8'));
      await runner`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
    }
  } finally {
    await runner.close();
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function postJson(target: Hono, path: string, body: unknown, cookie?: string): Promise<Response> {
  return await req(target, path, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function patchJson(target: Hono, path: string, body: unknown, cookie?: string): Promise<Response> {
  return await req(target, path, {
    method: 'PATCH',
    headers: {
      ...JSON_HEADERS,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The cookie the browser would send back: `factory_session=<token>`. */
function sessionCookie(response: Response): string | null {
  const raw = response.headers.get('set-cookie');
  if (!raw) return null;
  const match = /factory_session=([^;]*)/.exec(raw);
  return match?.[1] ? `factory_session=${match[1]}` : null;
}

async function login(email: string, password: string): Promise<{ response: Response; cookie: string | null }> {
  const response = await postJson(app, '/auth/login', { email, password });
  return { response, cookie: sessionCookie(response) };
}

suite('console auth API', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL as string;
    process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS as string;
    process.env.TEMPORAL_TASK_QUEUE = `factory-api-auth-itest-${process.pid}-${Date.now()}`;
    process.env.FACTORY_ROOT = join(REPO_ROOT, 'factories');
    process.env.REPO_ROOT = REPO_ROOT;

    await migrate(process.env.DATABASE_URL as string);
    sql = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    await sql`delete from users where username like ${`${PREFIX}%`}`;

    config = loadApiConfig({
      ...process.env,
      AUTH_REQUIRED: '1',
      AUTH_COOKIE_SECURE: '0',
      FACTORY_ADMIN_EMAIL: ADMIN_EMAIL,
      FACTORY_ADMIN_PASSWORD: ADMIN_PASSWORD,
      // No forge in this suite: personal-org provisioning is skipped entirely.
      GITHUB_API_BASE_URL: '',
      GITHUB_TOKEN: '',
    });

    admin = await createUser(sql, {
      email: ADMIN_EMAIL,
      username: `${PREFIX}-admin`,
      name: 'Integration Admin',
      password: ADMIN_PASSWORD,
      role: 'admin',
    });
    member = await createUser(sql, {
      email: MEMBER_EMAIL,
      username: `${PREFIX}-member`,
      name: 'Integration Member',
      password: MEMBER_PASSWORD,
      role: 'member',
    });

    app = createApp(config);
    authOffApp = createApp({ ...config, authRequired: false });
  }, 120_000);

  afterAll(async () => {
    const db = getSql();
    await db`delete from runs where id like ${'run_itest_auth_%'}`;
    for (const id of createdWorkItems) {
      await db`delete from work_items where id = ${id}`;
    }
    await db`delete from users where username like ${`${PREFIX}%`}`;
    await sql.close();
    await closeClient();
  }, 60_000);

  test('ensureBootstrapAdmin does not create a second admin when users exist', async () => {
    const result = await ensureBootstrapAdmin(config);
    expect(result.created).toBe(false);
    expect((await listUsers(sql)).length).toBeGreaterThanOrEqual(2);
  });

  test('login sets an HttpOnly SameSite=Lax session cookie', async () => {
    const { response, cookie } = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { user: { email: string; role: string } };
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.user.role).toBe('admin');
    expect(body).not.toHaveProperty('passwordHash');

    const raw = response.headers.get('set-cookie') ?? '';
    expect(raw).toContain('factory_session=');
    expect(raw.toLowerCase()).toContain('httponly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/');
    expect(raw).toContain('Max-Age=604800');
    expect(cookie).not.toBeNull();

    // Only the hash is persisted.
    const rows = (await sql`
      select token_hash from sessions where user_id = ${admin.id}
    `) as { token_hash: string }[];
    expect(rows.map((row) => row.token_hash)).not.toContain(cookie?.split('=')[1]);
  });

  test('a wrong password and an unknown email both answer 401 invalid_credentials', async () => {
    const wrong = await login(ADMIN_EMAIL, 'not-the-password');
    expect(wrong.response.status).toBe(401);
    expect(((await wrong.response.json()) as { code: string }).code).toBe('invalid_credentials');
    expect(wrong.cookie).toBeNull();

    const unknown = await login('nobody@factory.local', 'whatever-123');
    expect(unknown.response.status).toBe(401);
    expect(((await unknown.response.json()) as { code: string }).code).toBe('invalid_credentials');
    expect(unknown.cookie).toBeNull();
  });

  test('AUTH_REQUIRED=1 refuses protected routes with 401 auth_required', async () => {
    for (const path of ['/runs', '/work-items', '/users', '/auth/me', '/auth/forge-identity']) {
      const response = await req(app, path);
      expect({ path, status: response.status }).toEqual({ path, status: 401 });
      expect(((await response.json()) as { code: string }).code).toBe('auth_required');
    }

    // Public surface stays reachable.
    const health = await app.request('/health');
    expect([200, 503]).toContain(health.status);
    expect((await req(app, '/openapi.json')).status).toBe(200);
    expect((await req(app, '/auth/login', { method: 'POST' })).status).not.toBe(401);
  });

  test('GET /auth/me returns the signed-in user', async () => {
    const { cookie } = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    expect(cookie).not.toBeNull();

    const response = await req(app, '/auth/me', { headers: { cookie: cookie as string } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { email: string; role: string } | null };
    expect(body.user?.email).toBe(MEMBER_EMAIL);
    expect(body.user?.role).toBe('member');
  });

  test('GET /auth/forge-identity asserts the signed-in username', async () => {
    const { cookie } = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    const response = await req(app, '/auth/forge-identity', {
      headers: { cookie: cookie as string },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-webauth-user')).toBe(`${PREFIX}-member`);
    expect((await response.json()) as { username: string; fallback: boolean }).toEqual({
      username: `${PREFIX}-member`,
      fallback: false,
    });
  });

  test('logout revokes the session and clears the cookie', async () => {
    const { cookie } = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    const logout = await postJson(app, '/auth/logout', {}, cookie as string);
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie') ?? '').toContain('factory_session=;');

    const after = await req(app, '/auth/me', { headers: { cookie: cookie as string } });
    expect(after.status).toBe(401);
  });

  test('a member is refused user management with 403 forbidden', async () => {
    const { cookie } = await login(MEMBER_EMAIL, MEMBER_PASSWORD);

    const list = await req(app, '/users', { headers: { cookie: cookie as string } });
    expect(list.status).toBe(403);
    expect(((await list.json()) as { code: string }).code).toBe('forbidden');

    const create = await postJson(
      app,
      '/users',
      {
        email: `${PREFIX}-sneaky@factory.local`,
        username: `${PREFIX}-sneaky`,
        password: 'sneaky-pass',
      },
      cookie as string,
    );
    expect(create.status).toBe(403);
    expect(((await create.json()) as { code: string }).code).toBe('forbidden');

    const remove = await req(app, `/users/${admin.id}`, {
      method: 'DELETE',
      headers: { cookie: cookie as string },
    });
    expect(remove.status).toBe(403);
    expect(((await remove.json()) as { code: string }).code).toBe('forbidden');
  });

  test('an admin lists, creates and updates users', async () => {
    const { cookie } = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const list = await req(app, '/users', { headers: { cookie: cookie as string } });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { users: Array<{ username: string }> };
    expect(listed.users.map((user) => user.username)).toContain(`${PREFIX}-admin`);

    const created = await postJson(
      app,
      '/users',
      {
        email: `${PREFIX}-new@factory.local`,
        username: `${PREFIX}-new`,
        name: 'New Member',
        role: 'member',
        password: 'new-member-pass',
      },
      cookie as string,
    );
    expect(created.status).toBe(201);
    const newUser = ((await created.json()) as { user: User }).user;
    expect(newUser.role).toBe('member');
    expect(newUser).not.toHaveProperty('passwordHash');

    // The new account can sign in.
    const signedIn = await login(`${PREFIX}-new@factory.local`, 'new-member-pass');
    expect(signedIn.response.status).toBe(200);

    const duplicate = await postJson(
      app,
      '/users',
      {
        email: `${PREFIX}-new@factory.local`,
        username: `${PREFIX}-other`,
        password: 'another-pass',
      },
      cookie as string,
    );
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { code: string }).code).toBe('user_exists');

    const invalid = await postJson(
      app,
      '/users',
      { email: `${PREFIX}-bad@factory.local`, username: 'BadSlug', password: 'another-pass' },
      cookie as string,
    );
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { code: string }).code).toBe('invalid_user');

    const promoted = await patchJson(
      app,
      `/users/${newUser.id}`,
      { role: 'admin' },
      cookie as string,
    );
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { user: User }).user.role).toBe('admin');

    const disabled = await patchJson(
      app,
      `/users/${newUser.id}`,
      { disabled: true },
      cookie as string,
    );
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { user: User }).user.disabled).toBe(true);

    // A disabled account cannot sign in.
    const refused = await login(`${PREFIX}-new@factory.local`, 'new-member-pass');
    expect(refused.response.status).toBe(401);
    expect(((await refused.response.json()) as { code: string }).code).toBe('invalid_credentials');

    const unknown = await patchJson(
      app,
      '/users/00000000-0000-0000-0000-000000000000',
      { disabled: true },
      cookie as string,
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe('invalid_user');

    // Deleting removes the account and its sessions; the login stops working.
    const deleted = await req(app, `/users/${newUser.id}`, {
      method: 'DELETE',
      headers: { cookie: cookie as string },
    });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { deleted: boolean }).deleted).toBe(true);
    const gone = await login(`${PREFIX}-new@factory.local`, 'new-member-pass');
    expect(gone.response.status).toBe(401);

    // Self-deletion is refused.
    const self = await req(app, `/users/${admin.id}`, {
      method: 'DELETE',
      headers: { cookie: cookie as string },
    });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { code: string }).code).toBe('invalid_user');
  });

  test('members only see their own work items; admins see all', async () => {
    const memberSession = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    const adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const mine = await postJson(
      app,
      '/work-items',
      { factory: 'example', title: 'Member item', harness: 'fake' },
      memberSession.cookie as string,
    );
    expect(mine.status).toBe(201);
    const mineId = ((await mine.json()) as { workItem: { id: string } }).workItem.id;
    createdWorkItems.push(mineId);

    const theirs = await postJson(
      app,
      '/work-items',
      { factory: 'example', title: 'Admin item', harness: 'fake' },
      adminSession.cookie as string,
    );
    expect(theirs.status).toBe(201);
    const theirsId = ((await theirs.json()) as { workItem: { id: string } }).workItem.id;
    createdWorkItems.push(theirsId);

    // POST /work-items stores the session user as the owner.
    const owners = (await sql`
      select id, created_by from work_items where id in (${mineId}, ${theirsId})
    `) as { id: string; created_by: string | null }[];
    expect(owners.find((row) => row.id === mineId)?.created_by).toBe(member.id);
    expect(owners.find((row) => row.id === theirsId)?.created_by).toBe(admin.id);

    const memberList = await req(app, '/work-items?factory=example', {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(memberList.status).toBe(200);
    const memberItems = ((await memberList.json()) as { workItems: Array<{ id: string }> }).workItems;
    expect(memberItems.map((item) => item.id)).toContain(mineId);
    expect(memberItems.map((item) => item.id)).not.toContain(theirsId);

    const adminList = await req(app, '/work-items?factory=example', {
      headers: { cookie: adminSession.cookie as string },
    });
    expect(adminList.status).toBe(200);
    const adminItems = ((await adminList.json()) as { workItems: Array<{ id: string }> }).workItems;
    expect(adminItems.map((item) => item.id)).toContain(mineId);
    expect(adminItems.map((item) => item.id)).toContain(theirsId);

    // Detail and gate routes hide the other user's item behind 404.
    const foreign = await req(app, `/work-items/${theirsId}`, {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe('work_item_not_found');

    const foreignGate = await postJson(
      app,
      `/work-items/${theirsId}/gates/spec`,
      { decision: 'approve', actor: 'eve' },
      memberSession.cookie as string,
    );
    expect(foreignGate.status).toBe(404);

    const own = await req(app, `/work-items/${mineId}`, {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(own.status).toBe(200);
  }, 120_000);

  test('members only see their own runs; admins see all', async () => {
    const memberSession = await login(MEMBER_EMAIL, MEMBER_PASSWORD);
    const adminSession = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    const makeRun = async (suffix: string, createdBy: string | null): Promise<string> => {
      const runId = `run_itest_auth_${suffix}`;
      const input: RunInput = {
        runId,
        factory: 'example',
        factoryRoot: join(REPO_ROOT, 'factories', 'example'),
        definitionCommit: 'a'.repeat(40),
        definitionDirty: false,
        harness: 'fake',
        runner: 'fake',
        prompt: { text: `itest auth ${suffix}` },
        kind: 'chat',
        title: `itest auth ${suffix}`,
        proxyModels: [],
      };
      await insertRun({
        runId,
        factory: 'example',
        definitionCommit: input.definitionCommit,
        definitionDirty: false,
        harness: 'fake',
        model: null,
        runner: 'fake',
        kind: 'chat',
        title: input.title ?? null,
        input,
        workflowId: `wf-${runId}`,
        createdBy,
      });
      return runId;
    };

    const memberRun = await makeRun(`${process.pid}-member`, member.id);
    const adminRun = await makeRun(`${process.pid}-admin`, admin.id);
    const orphanRun = await makeRun(`${process.pid}-orphan`, null);

    const memberList = await req(app, '/runs?limit=100', {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(memberList.status).toBe(200);
    const memberRuns = ((await memberList.json()) as { runs: Array<{ id: string }> }).runs;
    expect(memberRuns.map((run) => run.id)).toContain(memberRun);
    expect(memberRuns.map((run) => run.id)).not.toContain(adminRun);
    expect(memberRuns.map((run) => run.id)).not.toContain(orphanRun);

    const adminList = await req(app, '/runs?limit=100', {
      headers: { cookie: adminSession.cookie as string },
    });
    const adminRuns = ((await adminList.json()) as { runs: Array<{ id: string }> }).runs;
    expect(adminRuns.map((run) => run.id)).toContain(memberRun);
    expect(adminRuns.map((run) => run.id)).toContain(adminRun);
    expect(adminRuns.map((run) => run.id)).toContain(orphanRun);

    const foreign = await req(app, `/runs/${adminRun}`, {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe('run_not_found');

    const own = await req(app, `/runs/${memberRun}`, {
      headers: { cookie: memberSession.cookie as string },
    });
    expect(own.status).toBe(200);
  }, 60_000);

  test('auth off keeps the old behaviour: no cookie, {user:null}, unscoped reads', async () => {
    const me = await req(authOffApp, '/auth/me');
    expect(me.status).toBe(200);
    expect((await me.json()) as { user: null }).toEqual({ user: null });

    const runs = await req(authOffApp, '/runs?limit=100');
    expect(runs.status).toBe(200);

    const workItems = await req(authOffApp, '/work-items?factory=example');
    expect(workItems.status).toBe(200);

    // User management stays reachable as the implicit local user.
    const users = await req(authOffApp, '/users');
    expect(users.status).toBe(200);
  });

  test('the bootstrap path is idempotent and the admin email is stored lower-case', async () => {
    const stored = await findUserByEmail(sql, ADMIN_EMAIL.toUpperCase());
    expect(stored?.email).toBe(ADMIN_EMAIL.toLowerCase());
    expect(await findUserByEmail(sql, 'missing@factory.local')).toBeNull();
    // v1() is the same prefix the routes live under.
    expect(v1('/auth/me')).toBe('/api/v1/auth/me');
  });
});
