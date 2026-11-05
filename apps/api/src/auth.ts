import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  USERNAME_RE,
  USER_ROLES,
  AuthRepositoryError,
  countActiveAdmins,
  countUsers,
  createSession,
  createUser,
  deleteUser,
  findSessionUser,
  findUserByEmail,
  findUserById,
  isUniqueViolation,
  listUsers,
  publicUser,
  revokeSession,
  setForgeOrg,
  updateUser,
  verifyPassword,
  type User,
  type UserRole,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import { randomBytes } from 'node:crypto';
import type { ApiConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { log } from './logger';
import { API_PREFIX } from './routes';

/**
 * Console auth (change `add-console-auth`, spec `console-auth`).
 *
 * - Opaque sessions hashed at rest (design decision 1); the browser only ever holds the
 *   `factory_session` cookie, HttpOnly + SameSite=Lax.
 * - `AUTH_REQUIRED` is the switch (design decision 3): when off, every request is treated
 *   as the implicit local user and the existing behaviour is unchanged.
 * - Public routes: `/health`, `/auth/login` and `/openapi.json`. Everything else needs a
 *   session when auth is required.
 * - Roles (design decision 4): `admin` manages users and sees all work; `member` sees only
 *   the rows they created.
 */

/** Context variables contributed by the auth middleware. */
export interface AuthVariables {
  user: User | null;
}

export type AuthContext = Context<{ Variables: AuthVariables }>;

/** Paths that stay reachable without a session when `AUTH_REQUIRED=1`. */
export const PUBLIC_PATHS = ['/health', '/auth/login', '/openapi.json'] as const;

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loginBodySchema = z
  .object({
    email: z.string().min(3).max(320),
    password: z.string().min(1).max(200),
  })
  .strict();

const createUserBodySchema = z
  .object({
    email: z.string().min(3).max(320),
    username: z.string().regex(USERNAME_RE, 'username must match [a-z0-9][a-z0-9_-]{1,38}'),
    name: z.string().max(120).optional(),
    role: z.enum(USER_ROLES).optional(),
    password: z.string().min(8).max(200),
  })
  .strict();

const updateUserBodySchema = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

type LoginBody = z.infer<typeof loginBodySchema>;
type CreateUserBody = z.infer<typeof createUserBodySchema>;
type UpdateUserBody = z.infer<typeof updateUserBodySchema>;

async function parseBody<T>(
  c: AuthContext,
  schema: z.ZodType<T>,
  /** Stable code for a schema violation; user administration uses `invalid_user`. */
  code = 'invalid_request',
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest('request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(code, 400, 'invalid request body', { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** The path below `/api/v1`, used for the public-route exemption. */
function apiRelativePath(path: string): string {
  if (!path.startsWith(API_PREFIX)) return path;
  return path.slice(API_PREFIX.length) || '/';
}

/**
 * Session middleware. Resolves the cookie, attaches the user to the context, and — when
 * `AUTH_REQUIRED=1` — refuses protected routes with `401 auth_required`. Registered on the
 * versioned router before any route, so a route cannot forget it.
 */
export function authMiddleware(config: ApiConfig): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await findSessionUser(getSql(), token) : null;
    c.set('user', user);

    if (config.authRequired && !user) {
      const relative = apiRelativePath(c.req.path);
      if (!(PUBLIC_PATHS as readonly string[]).includes(relative)) {
        throw new ApiError('auth_required', 401, 'sign in to use this API');
      }
    }

    await next();
  };
}

/**
 * Admin guard for user management. With auth off the API runs as the implicit local user
 * (design decision 3), so user management stays reachable; with auth on a member gets
 * `403 forbidden`.
 */
function requireAdmin(config: ApiConfig, user: User | null): void {
  if (!config.authRequired && !user) return;
  if (!user) throw new ApiError('auth_required', 401, 'sign in to use this API');
  if (user.role !== 'admin') {
    throw new ApiError('forbidden', 403, 'admin role required', { role: user.role });
  }
}

/**
 * Best-effort personal forge organization (`u-<username>`, design decision 6).
 *
 * Never fails login: a forge outage, a missing admin token or an org that already exists
 * all resolve to "no org recorded". The admin token is used only here and is never logged.
 */
export async function ensureForgeOrg(config: ApiConfig, user: User): Promise<string | null> {
  if (!config.forgeApiBaseUrl || !config.forgeAdminToken) return user.forgeOrg ?? null;

  const org = `${config.forgeOrgPrefix}${user.username}`;
  const base = config.forgeApiBaseUrl.replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `token ${config.forgeAdminToken}`,
  };
  const timeout = () => AbortSignal.timeout(5_000);

  try {
    const created = await fetch(`${base}/orgs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: org, visibility: 'private' }),
      signal: timeout(),
    });
    // 409/422: the org already exists (a previous login, or a race) — not an error.
    if (!created.ok && created.status !== 409 && created.status !== 422) {
      log('warn', 'forge_org_provision_failed', {
        userId: user.id,
        org,
        step: 'create',
        status: created.status,
      });
      return null;
    }

    const member = await fetch(
      `${base}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(user.username)}`,
      { method: 'PUT', headers, signal: timeout() },
    );
    // Forgejo answers 405 for this membership call on some versions; the org creator is
    // already an owner, so it is not a failure. 409 is the same "already a member" case.
    if (!member.ok && member.status !== 409 && member.status !== 405) {
      log('warn', 'forge_org_provision_failed', {
        userId: user.id,
        org,
        step: 'membership',
        status: member.status,
      });
      return null;
    }

    await setForgeOrg(getSql(), user.id, org);
    log('info', 'forge_org_provisioned', { userId: user.id, org });
    return org;
  } catch (error) {
    log('warn', 'forge_org_provision_failed', {
      userId: user.id,
      org,
      step: 'request',
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Bootstrap admin (design decision 2). Called once before the API serves traffic: if there
 * is no user at all, create the admin from `FACTORY_ADMIN_EMAIL` / `FACTORY_ADMIN_PASSWORD`.
 * An unset password is generated and disclosed **once** in the start-up log — that line is
 * the only place it is ever written.
 */
export async function ensureBootstrapAdmin(
  config: ApiConfig,
): Promise<{ created: boolean; email: string }> {
  const sql = getSql(config.databaseUrl);
  const existing = await countUsers(sql);
  if (existing > 0) return { created: false, email: config.adminEmail };

  const generated = !config.adminPassword;
  const password =
    config.adminPassword ?? randomBytes(12).toString('base64url').slice(0, 16);

  const email = config.adminEmail.trim().toLowerCase();
  const username =
    email
      .split('@')[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 39) || 'admin';

  await createUser(sql, {
    email,
    username: USERNAME_RE.test(username) ? username : 'admin',
    name: 'Administrator',
    password,
    role: 'admin',
  });

  log('info', 'bootstrap_admin_created', { email, username, generated });
  if (generated) {
    // Deliberate one-time disclosure: the operator needs this password to sign in. The
    // key is not named `password`, so `redact` leaves it intact; it is never logged again.
    log('warn', 'bootstrap_admin_password_generated', { email, generatedPassword: password });
  }

  return { created: true, email };
}

function setSessionCookie(c: AuthContext, config: ApiConfig, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: config.authCookieSecure,
  });
}

function clearSessionCookie(c: AuthContext, config: ApiConfig): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.authCookieSecure });
}

/** Registers `/auth/*` and `/users*` on the versioned router. */
export function registerAuth(api: Hono<{ Variables: AuthVariables }>, config: ApiConfig): void {
  /* -------------------------------------------------------------- sessions */

  api.post('/auth/login', async (c) => {
    const body = await parseBody<LoginBody>(c, loginBodySchema);
    const sql = getSql();
    const user = await findUserByEmail(sql, body.email);

    // One response for "no such user", "wrong password" and "disabled": the client learns
    // nothing about which emails exist.
    if (!user || !(await verifyPassword(user, body.password))) {
      throw new ApiError('invalid_credentials', 401, 'invalid email or password');
    }

    const created = await createSession(sql, user.id);
    setSessionCookie(c, config, created.token);

    const publicUserRecord = publicUser(user);
    log('info', 'auth_login', { userId: user.id, username: user.username });

    // Best effort and after the cookie is set: a forge outage must not fail login.
    await ensureForgeOrg(config, publicUserRecord);

    return c.json({ user: publicUserRecord, expiresAt: created.expiresAt });
  });

  api.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await revokeSession(getSql(), token);
    clearSessionCookie(c, config);
    return c.json({ ok: true });
  });

  api.get('/auth/me', (c) => {
    const user = c.get('user');
    return c.json({ user: user ?? null });
  });

  /**
   * Forge identity for the optional websocket proxy (change `polish-forge-and-public`).
   *
   * `Caddyfile` runs this through `forward_auth` before reverse-proxying to Forgejo: a 200
   * copies `X-WebAuth-User` onto the proxied request, anything else stops it. With
   * `AUTH_REQUIRED=1` the session middleware already answers 401 when nobody is signed in,
   * so the forge is never reached anonymously. With auth off the API is the implicit local
   * user, so it asserts `FORGEJO_ADMIN_USER` — the same fallback the console proxy uses
   * (ADR-032) — keeping the proxy mode usable for local development.
   */
  api.get('/auth/forge-identity', (c) => {
    const user = c.get('user');
    if (!user && config.authRequired) {
      throw new ApiError('auth_required', 401, 'sign in to use the local forge');
    }
    const username = user?.username ?? config.forgeAdminUser;
    c.header('X-WebAuth-User', username);
    return c.json({ username, fallback: user === null });
  });

  /* ---------------------------------------------------------- user admin */

  api.get('/users', async (c) => {
    requireAdmin(config, c.get('user'));
    return c.json({ users: await listUsers(getSql()) });
  });

  api.post('/users', async (c) => {
    requireAdmin(config, c.get('user'));
    const body = await parseBody<CreateUserBody>(c, createUserBodySchema, 'invalid_user');

    try {
      const user = await createUser(getSql(), {
        email: body.email,
        username: body.username,
        ...(body.name !== undefined ? { name: body.name } : {}),
        password: body.password,
        ...(body.role !== undefined ? { role: body.role } : {}),
      });
      log('info', 'user_created', { userId: user.id, username: user.username, role: user.role });
      return c.json({ user }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('user_exists', 409, 'email or username is already taken', {
          email: body.email,
          username: body.username,
        });
      }
      if (error instanceof AuthRepositoryError) {
        throw new ApiError(error.code, 400, error.message, error.details);
      }
      throw error;
    }
  });

  api.patch('/users/:id', async (c) => {
    requireAdmin(config, c.get('user'));
    const id = c.req.param('id');
    if (!USER_ID_RE.test(id)) throw new ApiError('invalid_user', 400, 'invalid user id', { id });

    const body = await parseBody<UpdateUserBody>(c, updateUserBodySchema, 'invalid_user');
    if (body.role === undefined && body.disabled === undefined) {
      throw new ApiError('invalid_user', 400, 'provide `role` and/or `disabled`');
    }

    try {
      const updated = await updateUser(getSql(), id, {
        ...(body.role !== undefined ? { role: body.role as UserRole } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      });
      if (!updated) throw new ApiError('invalid_user', 404, `user "${id}" does not exist`, { id });
      log('info', 'user_updated', {
        userId: updated.id,
        role: updated.role,
        disabled: updated.disabled,
      });
      return c.json({ user: updated });
    } catch (error) {
      if (error instanceof AuthRepositoryError) {
        throw new ApiError(error.code, 400, error.message, error.details);
      }
      throw error;
    }
  });

  api.delete('/users/:id', async (c) => {
    requireAdmin(config, c.get('user'));
    const id = c.req.param('id');
    if (!USER_ID_RE.test(id)) throw new ApiError('invalid_user', 400, 'invalid user id', { id });

    const me = c.get('user');
    if (me && me.id === id) {
      throw new ApiError('invalid_user', 400, 'cannot delete your own account', { id });
    }

    const sql = getSql();
    const target = await findUserById(sql, id);
    if (!target) throw new ApiError('invalid_user', 404, `user "${id}" does not exist`, { id });

    // Deleting the last active admin would lock the deployment out.
    if (target.role === 'admin' && !target.disabled) {
      const remaining = await countActiveAdmins(sql, id);
      if (remaining === 0) {
        throw new ApiError('invalid_user', 400, 'cannot delete the last active admin', { id });
      }
    }

    await deleteUser(sql, id);
    log('info', 'user_deleted', { userId: id, username: target.username });
    return c.json({ deleted: true, id });
  });
}

/* ------------------------------------------------------------ scope helpers */

/**
 * A viewer for read-scope decisions. `null` means "no scoping" — auth off, where the API
 * behaves exactly as before (design decision 3).
 */
export interface Viewer {
  id: string;
  role: UserRole;
  username: string;
}

export function viewerOf(config: ApiConfig, user: User | null): Viewer | null {
  // With auth off the API is the implicit local user and keeps its old, unscoped
  // behaviour — a stale cookie must not narrow the list.
  if (!config.authRequired || !user) return null;
  return { id: user.id, role: user.role, username: user.username };
}

/** The `created_by` value for a new row; null when auth is off (old behaviour). */
export function sessionUserId(config: ApiConfig, user: User | null): string | null {
  if (!config.authRequired || !user) return null;
  return user.id;
}

/** Members see only their own rows; admins see everything. */
export function ownerFilter(viewer: Viewer | null): string | null {
  if (!viewer) return null;
  return viewer.role === 'admin' ? null : viewer.id;
}

/** True when the viewer may read a row owned by `ownerId`. */
export function canAccess(viewer: Viewer | null, ownerId: string | null): boolean {
  if (!viewer) return true;
  if (viewer.role === 'admin') return true;
  return ownerId !== null && ownerId === viewer.id;
}

/**
 * Factory ownership (change `add-factory-identity`, spec `factory-identity` › Owner scope).
 *
 * Auth off → no scoping (the implicit local user sees everything, design decision 3).
 * Admin → every factory. Member → only factories whose registry `owner_id` is their id.
 * A factory with no owner (legacy directory in a pre-auth database) is admin-only.
 */
export function canAccessFactory(
  viewer: Viewer | null,
  factory: { ownerId: string | null },
): boolean {
  if (!viewer) return true;
  if (viewer.role === 'admin') return true;
  return factory.ownerId !== null && factory.ownerId === viewer.id;
}
