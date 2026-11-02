import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { req } from './helpers';

/**
 * `GET /api/v1/auth/forge-identity` (change `polish-forge-and-public`, spec
 * `forge-transport` › Optional websocket proxy).
 *
 * The optional Caddy mode runs this route through `forward_auth`: a 200 copies
 * `X-WebAuth-User` onto the proxied request, anything else stops it. No database access is
 * needed here — an anonymous request never reaches the session lookup.
 */

const authOn = createApp(
  loadApiConfig({
    DATABASE_URL: 'postgres://factory:factory@localhost:5433/factory',
    FACTORY_ROOT: 'factories',
    AUTH_REQUIRED: '1',
    FORGEJO_ADMIN_USER: 'factory',
  }),
);

const authOff = createApp(
  loadApiConfig({
    DATABASE_URL: 'postgres://factory:factory@localhost:5433/factory',
    FACTORY_ROOT: 'factories',
    AUTH_REQUIRED: '0',
    FORGEJO_ADMIN_USER: 'factory',
  }),
);

describe('GET /auth/forge-identity', () => {
  test('answers 401 auth_required without a session when auth is required', async () => {
    const response = await req(authOn, '/auth/forge-identity');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('auth_required');
    expect(response.headers.get('x-webauth-user')).toBeNull();
  });

  test('asserts the admin fallback when auth is off', async () => {
    const response = await req(authOff, '/auth/forge-identity');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-webauth-user')).toBe('factory');
    expect((await response.json()) as { username: string; fallback: boolean }).toEqual({
      username: 'factory',
      fallback: true,
    });
  });
});
