import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
  createSession,
  createUser,
  findSessionUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  hashSessionToken,
  listUsers,
  revokeSession,
  updateUser,
  verifyPassword,
} from '../src/index';

/**
 * Auth repository against a real database (change `add-console-auth`, task 4.1).
 *
 * Opt-in like the other integration suites:
 *
 *   docker compose up -d
 *   DATABASE_URL=postgres://factory:factory@localhost:5433/factory_test \
 *   RUN_INTEGRATION=1 bun test packages/core/test/auth.integration.test.ts
 */

const enabled = process.env.RUN_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const suite = enabled ? describe : describe.skip;

const PREFIX = `itest-auth-${process.pid}`;
const PASSWORD = 'itest-correct-horse';

let sql: SQL;
let userId: string;

suite('auth repository', () => {
  beforeAll(async () => {
    sql = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    await sql`delete from users where username like ${`${PREFIX}%`}`;
  });

  afterAll(async () => {
    await sql`delete from users where username like ${`${PREFIX}%`}`;
    await sql.close();
  });

  test('createUser stores an argon2id hash, never the password', async () => {
    const user = await createUser(sql, {
      email: `${PREFIX}@example.com`,
      username: `${PREFIX}-admin`,
      name: 'Integration Admin',
      password: PASSWORD,
      role: 'admin',
    });
    userId = user.id;

    expect(user.email).toBe(`${PREFIX}@example.com`);
    expect(user.role).toBe('admin');
    expect(user.disabled).toBe(false);
    expect(Object.keys(user)).not.toContain('passwordHash');

    const row = (await sql`
      select password_hash from users where id = ${user.id}
    `) as { password_hash: string }[];
    expect(row[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row[0]?.password_hash).not.toContain(PASSWORD);
  });

  test('find by email/username/id and verify the password', async () => {
    const byEmail = await findUserByEmail(sql, `${PREFIX.toUpperCase()}@EXAMPLE.COM`);
    expect(byEmail?.id).toBe(userId);

    const byUsername = await findUserByUsername(sql, `${PREFIX}-admin`);
    expect(byUsername?.id).toBe(userId);

    const byId = await findUserById(sql, userId);
    expect(byId?.email).toBe(`${PREFIX}@example.com`);

    expect(await verifyPassword(byId as NonNullable<typeof byId>, PASSWORD)).toBe(true);
    expect(await verifyPassword(byId as NonNullable<typeof byId>, 'wrong')).toBe(false);
    expect(await findUserByEmail(sql, 'nobody@example.com')).toBeNull();
  });

  test('a session token resolves its user; only the hash is stored', async () => {
    const created = await createSession(sql, userId);
    expect(created.token).toHaveLength(43);
    expect(created.expiresAt).toBeDefined();

    const rows = (await sql`
      select token_hash from sessions where user_id = ${userId}
    `) as { token_hash: string }[];
    expect(rows.some((row) => row.token_hash === hashSessionToken(created.token))).toBe(true);
    expect(rows.map((row) => row.token_hash)).not.toContain(created.token);

    const user = await findSessionUser(sql, created.token);
    expect(user?.id).toBe(userId);
    expect(user).not.toHaveProperty('passwordHash');
    expect(await findSessionUser(sql, 'not-a-real-token')).toBeNull();

    expect(await revokeSession(sql, created.token)).toBe(true);
    expect(await findSessionUser(sql, created.token)).toBeNull();
    expect(await revokeSession(sql, created.token)).toBe(false);
  });

  test('an expired session is rejected', async () => {
    const expired = await createSession(sql, userId, { ttlMs: -1_000 });
    expect(await findSessionUser(sql, expired.token)).toBeNull();
    await sql`delete from sessions where token_hash = ${hashSessionToken(expired.token)}`;
  });

  test('a disabled user never authenticates, even with a valid session', async () => {
    const created = await createSession(sql, userId);
    const disabled = await updateUser(sql, userId, { disabled: true });
    expect(disabled?.disabled).toBe(true);

    const user = await findUserById(sql, userId);
    expect(await verifyPassword(user as NonNullable<typeof user>, PASSWORD)).toBe(false);
    expect(await findSessionUser(sql, created.token)).toBeNull();

    await updateUser(sql, userId, { disabled: false });
    expect((await findSessionUser(sql, created.token))?.id).toBe(userId);
    await revokeSession(sql, created.token);
  });

  test('listUsers includes the account; updateUser rejects an unknown role', async () => {
    const users = await listUsers(sql);
    expect(users.some((user) => user.id === userId)).toBe(true);
    expect(users.every((user) => !Object.keys(user).includes('passwordHash'))).toBe(true);

    await expect(
      updateUser(sql, userId, { role: 'owner' as never }),
    ).rejects.toMatchObject({ code: 'invalid_user' });

    const promoted = await updateUser(sql, userId, { role: 'member' });
    expect(promoted?.role).toBe('member');
    expect(await updateUser(sql, '00000000-0000-0000-0000-000000000000', { disabled: true })).toBeNull();
  });

  test('a duplicate email or username surfaces as a unique violation', async () => {
    let caught: unknown;
    try {
      await createUser(sql, {
        email: `${PREFIX}@example.com`,
        username: `${PREFIX}-other`,
        password: PASSWORD,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });
});
