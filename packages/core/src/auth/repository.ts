import type { SQL } from 'bun';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Console auth repository (change `add-console-auth`, spec `console-auth`).
 *
 * Users authenticate with a password (argon2id via `Bun.password`) and receive an opaque
 * session token. Only the SHA-256 hash of the token is stored, so the database never holds
 * a usable credential (design decision 1: opaque sessions, hashed at rest — no JWT, no
 * signing key to rotate).
 *
 * Every function takes the `SQL` handle explicitly, matching the other repositories
 * (ADR-010: plain SQL over Bun's `SQL` client, no ORM).
 */

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Slug rule: lower-case alphanumerics, `_` and `-`; 2–39 chars, alphanumeric first. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,38}$/;

/** Session lifetime. The cookie's `Max-Age` mirrors it (7 days). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The cookie name carried by the browser (HttpOnly, SameSite=Lax, Path=/). */
export const SESSION_COOKIE = 'factory_session';

export interface User {
  id: string;
  email: string;
  username: string;
  name: string | null;
  role: UserRole;
  disabled: boolean;
  forgeOrg: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A user row including the hash, for password verification only. Never serialised. */
export interface UserWithPassword extends User {
  passwordHash: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string | null;
  lastSeenAt: string | null;
}

export class AuthRepositoryError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AuthRepositoryError';
    this.code = code;
    this.details = details;
  }
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  name: string | null;
  password_hash: string;
  role: string;
  disabled: boolean;
  forge_org: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: unknown;
  created_at: unknown;
  last_seen_at: unknown;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapUser(row: UserRow): UserWithPassword {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    name: row.name,
    passwordHash: row.password_hash,
    role: row.role === 'admin' ? 'admin' : 'member',
    disabled: row.disabled === true,
    forgeOrg: row.forge_org,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** Strips the hash before a user crosses the HTTP boundary. */
export function publicUser(user: UserWithPassword | User): User {
  const { passwordHash: _hash, ...rest } = user as UserWithPassword;
  return rest;
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

/** Emails are compared case-insensitively; the stored form is lower-case. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The at-rest form of a session token. Deterministic, so lookups are a single index hit. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes, base64url: 256 bits of entropy, cookie-safe, no padding. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Postgres unique violation (`23505`), raised by a duplicate email or username. */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { errno?: string; code?: string; message?: string };
  return (
    candidate.errno === '23505' ||
    candidate.code === '23505' ||
    (typeof candidate.message === 'string' && candidate.message.includes('duplicate key'))
  );
}

export interface CreateUserArgs {
  email: string;
  username: string;
  name?: string | null;
  password: string;
  role?: UserRole;
}

/**
 * Creates a user with an argon2id password hash. The caller decides whether a duplicate
 * is a 409 (`user_exists`) — the repository only reports it as `isUniqueViolation`.
 */
export async function createUser(sql: SQL, args: CreateUserArgs): Promise<User> {
  const email = normalizeEmail(args.email);
  if (!isValidUsername(args.username)) {
    throw new AuthRepositoryError(
      'invalid_user',
      `username "${args.username}" must match ${USERNAME_RE.source}`,
      { username: args.username },
    );
  }
  if (args.password.length < 8) {
    throw new AuthRepositoryError('invalid_user', 'password must be at least 8 characters');
  }

  const passwordHash = await Bun.password.hash(args.password, {
    algorithm: 'argon2id',
    memoryCost: 65_536,
    timeCost: 2,
  });

  const rows = (await sql`
    insert into users (email, username, name, password_hash, role, updated_at)
    values (
      ${email}, ${args.username}, ${args.name ?? null}, ${passwordHash},
      ${args.role ?? 'member'}, now()
    )
    returning *
  `) as UserRow[];

  return publicUser(mapUser(rows[0] as UserRow));
}

export async function findUserByEmail(sql: SQL, email: string): Promise<UserWithPassword | null> {
  const rows = (await sql`
    select * from users where email = ${normalizeEmail(email)} limit 1
  `) as UserRow[];
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByUsername(
  sql: SQL,
  username: string,
): Promise<UserWithPassword | null> {
  const rows = (await sql`
    select * from users where username = ${username} limit 1
  `) as UserRow[];
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(sql: SQL, id: string): Promise<UserWithPassword | null> {
  const rows = (await sql`select * from users where id = ${id} limit 1`) as UserRow[];
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Constant-time argon2id verification; a disabled user never authenticates. */
export async function verifyPassword(
  user: UserWithPassword,
  password: string,
): Promise<boolean> {
  if (user.disabled) return false;
  try {
    return await Bun.password.verify(password, user.passwordHash);
  } catch {
    return false;
  }
}

export interface CreatedSession {
  session: SessionRecord;
  /** Returned exactly once: the browser cookie carries it; only the hash is stored. */
  token: string;
  expiresAt: string;
}

export async function createSession(
  sql: SQL,
  userId: string,
  options: { ttlMs?: number } = {},
): Promise<CreatedSession> {
  const token = newSessionToken();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const rows = (await sql`
    insert into sessions (user_id, token_hash, expires_at, last_seen_at)
    values (${userId}, ${hashSessionToken(token)}, ${expiresAt}, now())
    returning *
  `) as SessionRow[];

  const row = rows[0] as SessionRow;
  return {
    token,
    expiresAt,
    session: {
      id: row.id,
      userId: row.user_id,
      expiresAt: iso(row.expires_at) as string,
      createdAt: iso(row.created_at),
      lastSeenAt: iso(row.last_seen_at),
    },
  };
}

/**
 * Resolves the user behind a session token. Expired sessions and disabled users are
 * rejected; a valid hit touches `last_seen_at` (best effort — a failed touch must not
 * reject an otherwise valid session).
 */
export async function findSessionUser(sql: SQL, token: string): Promise<User | null> {
  if (!token) return null;
  const rows = (await sql`
    select u.*, s.id as session_id, s.expires_at
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${hashSessionToken(token)}
    limit 1
  `) as (UserRow & { session_id: string; expires_at: unknown })[];

  const row = rows[0];
  if (!row) return null;
  if (row.disabled === true) return null;

  const expiresAt = iso(row.expires_at);
  if (!expiresAt || Date.parse(expiresAt) <= Date.now()) return null;

  try {
    await sql`update sessions set last_seen_at = now() where id = ${row.session_id}`;
  } catch {
    // A read-path touch is an optimisation, not a correctness requirement.
  }

  return publicUser(mapUser(row));
}

export async function revokeSession(sql: SQL, token: string): Promise<boolean> {
  if (!token) return false;
  const rows = (await sql`
    delete from sessions where token_hash = ${hashSessionToken(token)} returning id
  `) as { id: string }[];
  return rows.length > 0;
}

/** Housekeeping: drop sessions past their expiry (called by the bootstrap path). */
export async function pruneExpiredSessions(sql: SQL): Promise<number> {
  const rows = (await sql`
    delete from sessions where expires_at <= now() returning id
  `) as { id: string }[];
  return rows.length;
}

export async function listUsers(sql: SQL): Promise<User[]> {
  const rows = (await sql`
    select * from users order by created_at asc, username asc
  `) as UserRow[];
  return rows.map((row) => publicUser(mapUser(row)));
}

export async function countUsers(sql: SQL): Promise<number> {
  const rows = (await sql`select count(*)::int as count from users`) as { count: number }[];
  return Number(rows[0]?.count ?? 0);
}

export interface UpdateUserPatch {
  role?: UserRole;
  disabled?: boolean;
}

/** Admin-only user administration (spec: role and status). Returns null when absent. */
export async function updateUser(
  sql: SQL,
  id: string,
  patch: UpdateUserPatch,
): Promise<User | null> {
  if (patch.role !== undefined && !(USER_ROLES as readonly string[]).includes(patch.role)) {
    throw new AuthRepositoryError('invalid_user', `unknown role "${patch.role}"`, {
      allowed: [...USER_ROLES],
    });
  }

  const rows = (await sql`
    update users set
      role = coalesce(${patch.role ?? null}, role),
      disabled = coalesce(${patch.disabled ?? null}, disabled),
      updated_at = now()
    where id = ${id}
    returning *
  `) as UserRow[];

  return rows[0] ? publicUser(mapUser(rows[0])) : null;
}

/** Records the personal forge org provisioned on first login (best effort). */
export async function setForgeOrg(sql: SQL, userId: string, forgeOrg: string): Promise<void> {
  await sql`
    update users set forge_org = ${forgeOrg}, updated_at = now() where id = ${userId}
  `;
}
