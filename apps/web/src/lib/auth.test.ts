import { describe, expect, test } from 'bun:test';
import { authGateDecision } from './auth';

/**
 * Regression: a restarting API used to make `/auth/me` fail, which the root layout read as
 * "signed out" and redirected to `/login` on every auto-refresh. A network/5xx failure must
 * render the degraded shell; only an answered 401/403 (or an answered "no user") redirects.
 */
describe('authGateDecision', () => {
  test('auth off renders every page', () => {
    expect(
      authGateDecision({
        authRequired: false,
        pathname: '/factories/fac_test/missions',
        user: null,
        error: null,
      }),
    ).toBe('render');
  });

  test('public login page renders without a session', () => {
    expect(
      authGateDecision({
        authRequired: true,
        pathname: '/login',
        user: null,
        error: null,
      }),
    ).toBe('render');
  });

  test('signed-in user renders a protected page', () => {
    expect(
      authGateDecision({
        authRequired: true,
        pathname: '/inbox',
        user: { id: 'user_1' },
        error: null,
      }),
    ).toBe('render');
  });

  test('answered no-user response redirects to sign-in', () => {
    expect(
      authGateDecision({
        authRequired: true,
        pathname: '/inbox',
        user: null,
        error: null,
      }),
    ).toBe('redirect');
  });

  test('401 and 403 redirect to sign-in', () => {
    for (const status of [401, 403]) {
      expect(
        authGateDecision({
          authRequired: true,
          pathname: '/inbox',
          user: null,
          error: { status },
        }),
      ).toBe('redirect');
    }
  });

  test('network and 5xx failures render the degraded shell instead of redirecting', () => {
    for (const status of [0, 500, 502, 503]) {
      expect(
        authGateDecision({
          authRequired: true,
          pathname: '/inbox',
          user: null,
          error: { status },
        }),
      ).toBe('render');
    }
  });
});
