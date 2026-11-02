import { describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import {
  AuthRepositoryError,
  SESSION_TTL_MS,
  USERNAME_RE,
  createUser,
  hashSessionToken,
  isUniqueViolation,
  isValidUsername,
  newSessionToken,
  normalizeEmail,
  publicUser,
  type UserWithPassword,
} from '../src/index';

/**
 * Pure auth-repository tests (change `add-console-auth`). The database-backed behaviour is
 * covered by `auth.integration.test.ts`; everything here runs in CI with no Postgres.
 */

const fakeSql = {} as SQL;

describe('username slug', () => {
  test('accepts lower-case slugs', () => {
    expect(isValidUsername('ada')).toBe(true);
    expect(isValidUsername('ada-lovelace')).toBe(true);
    expect(isValidUsername('ada_lovelace_2')).toBe(true);
    expect(isValidUsername('a1')).toBe(true);
  });

  test('rejects upper-case, leading punctuation and out-of-range lengths', () => {
    expect(isValidUsername('Ada')).toBe(false);
    expect(isValidUsername('_ada')).toBe(false);
    expect(isValidUsername('-ada')).toBe(false);
    expect(isValidUsername('a')).toBe(false);
    expect(isValidUsername('a'.repeat(40))).toBe(false);
    expect(isValidUsername('ada lovelace')).toBe(false);
  });

  test('the exported regex matches the migration check constraint', () => {
    expect(USERNAME_RE.source).toBe('^[a-z0-9][a-z0-9_-]{1,38}$');
  });
});

describe('email normalisation', () => {
  test('trims and lower-cases so lookups are case-insensitive', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  });
});

describe('session tokens', () => {
  test('are 32 random bytes in base64url (43 chars, cookie-safe)', () => {
    const token = newSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(newSessionToken()).not.toBe(token);
  });

  test('hash to a deterministic 64-char hex digest, so the DB never holds the token', () => {
    const token = newSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hashSessionToken(newSessionToken())).not.toBe(hash);
    expect(hash).not.toContain(token);
  });

  test('the cookie lifetime is seven days', () => {
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('public user projection', () => {
  test('strips the password hash', () => {
    const user: UserWithPassword = {
      id: 'u1',
      email: 'ada@example.com',
      username: 'ada',
      name: null,
      passwordHash: 'argon2id$secret',
      role: 'admin',
      disabled: false,
      forgeOrg: null,
      createdAt: null,
      updatedAt: null,
    };
    const projected = publicUser(user);
    expect(Object.keys(projected).sort()).not.toContain('passwordHash');
    expect(JSON.stringify(projected)).not.toContain('argon2id');
    expect(projected.username).toBe('ada');
  });
});

describe('unique violation detection', () => {
  test('recognises Postgres 23505 in its several shapes', () => {
    expect(isUniqueViolation({ errno: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(
      isUniqueViolation(new Error('duplicate key value violates unique constraint "users_email_key"')),
    ).toBe(true);
  });

  test('does not swallow unrelated errors', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('createUser validation', () => {
  test('an invalid username is rejected before any SQL runs', async () => {
    await expect(
      createUser(fakeSql, {
        email: 'Ada@Example.com',
        username: 'Ada',
        password: 'correct-horse',
      }),
    ).rejects.toBeInstanceOf(AuthRepositoryError);
  });

  test('a short password is rejected before hashing', async () => {
    await expect(
      createUser(fakeSql, {
        email: 'ada@example.com',
        username: 'ada',
        password: 'short',
      }),
    ).rejects.toMatchObject({ code: 'invalid_user' });
  });
});
