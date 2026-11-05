import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { installCommand, preflightCommand } from '../src/runners';
import { req } from './helpers';

/**
 * Runner routes: rejection codes and command rendering.
 *
 * Every case here is refused **before** a database write (schema validation, bearer-token
 * guard, or pure string rendering), so CI without Postgres covers the stable codes:
 * `invalid_request`, `agent_unauthorized`, `enrollment_invalid`. The persistence paths are
 * exercised by the worker/store integration suites.
 */

const repoRoot = resolve('.');
const config = loadApiConfig({
  ...process.env,
  FACTORY_ROOT: join(repoRoot, 'factories'),
  REPO_ROOT: repoRoot,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
  // Auth off: the console routes run as the implicit local user, so a bad body reaches the
  // validator instead of `401 auth_required`.
  AUTH_REQUIRED: '0',
});

const app = createApp(config);

const authRequiredApp = createApp(
  loadApiConfig({
    ...process.env,
    FACTORY_ROOT: join(repoRoot, 'factories'),
    REPO_ROOT: repoRoot,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
    AUTH_REQUIRED: '1',
  }),
);

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(
  path: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await req(app, path, {
    method,
    ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

describe('runner enrollment validation', () => {
  test('a missing name is invalid_request', async () => {
    const { status, body } = await send('/runners/enrollments', 'POST', {
      platform: 'linux',
      arch: 'x64',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('an unknown platform is invalid_request', async () => {
    const { status, body } = await send('/runners/enrollments', 'POST', {
      name: 'linux-1',
      platform: 'plan9',
      arch: 'x64',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('unknown fields are rejected (strict schema)', async () => {
    const { status, body } = await send('/runners/enrollments', 'POST', {
      name: 'linux-1',
      platform: 'linux',
      arch: 'x64',
      token: 'smuggled',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('a non-JSON body is invalid_request', async () => {
    const response = await req(app, '/runners/enrollments', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'not json',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('invalid_request');
  });
});

describe('runner host action validation', () => {
  test('drain requires a boolean flag', async () => {
    const { status, body } = await send('/runners/rhost_x/drain', 'POST', { drain: 'yes' });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('silence requires a parseable future timestamp', async () => {
    const bad = await send('/runner-alerts/ralert_x/silence', 'POST', { until: 'tomorrow' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');

    const past = await send('/runner-alerts/ralert_x/silence', 'POST', {
      until: '2020-01-01T00:00:00.000Z',
    });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('invalid_request');
    expect(past.body.details.until).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('runner alert rule validation', () => {
  test('an empty comparison is rejected', async () => {
    const { status, body } = await send('/runner-alert-rules', 'PUT', {
      rules: [
        {
          id: 'cpu-warning',
          scope: 'global',
          metric: 'cpu_percent',
          comparison: 'gte',
          threshold: 85,
          durationSeconds: 0,
          severity: 'warning',
        },
      ],
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('a negative duration is rejected', async () => {
    const { status, body } = await send('/runner-alert-rules', 'PUT', {
      rules: [
        {
          id: 'cpu-warning',
          scope: 'global',
          metric: 'cpu_percent',
          comparison: 'gt',
          threshold: 85,
          durationSeconds: -1,
          severity: 'warning',
        },
      ],
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('a missing rules array is rejected', async () => {
    const { status, body } = await send('/runner-alert-rules', 'PUT', {});
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });
});

describe('agent route validation', () => {
  test('preflight validates the check map before touching the enrollment', async () => {
    const { status, body } = await send(
      '/runner-enrollments/ren_unknown/preflight',
      'POST',
      { platform: 'linux', checks: { docker: { ok: 'yes' } } },
    );
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('enroll validates the host metadata before the token exchange', async () => {
    const { status, body } = await send('/runner-agent/enroll', 'POST', {
      token: 'ren_x',
      name: 'linux-1',
      platform: 'linux',
      arch: 'x64',
      maxConcurrent: 0,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('command claim without a bearer token is agent_unauthorized', async () => {
    const { status, body } = await send('/runner-agent/commands?waitMs=0', 'GET');
    expect(status).toBe(401);
    expect(body.code).toBe('agent_unauthorized');
  });

  test('heartbeat without a bearer token is agent_unauthorized', async () => {
    const { status, body } = await send('/runner-agent/heartbeat', 'POST', {});
    expect(status).toBe(401);
    expect(body.code).toBe('agent_unauthorized');
  });

  test('a malformed Authorization header is agent_unauthorized', async () => {
    const response = await req(app, '/runner-agent/commands?waitMs=0', {
      headers: { authorization: 'Basic abc' },
    });
    expect(response.status).toBe(401);
  });
});

describe('agent routes bypass the console session middleware', () => {
  test('with AUTH_REQUIRED=1 the agent claim answers agent_unauthorized, not auth_required', async () => {
    const response = await authRequiredApp.request('/api/v1/runner-agent/commands?waitMs=0');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('agent_unauthorized');
  });

  test('with AUTH_REQUIRED=1 the console runner list still requires a session', async () => {
    const response = await authRequiredApp.request('/api/v1/runners');
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe('auth_required');
  });

  test('with AUTH_REQUIRED=1 preflight stays reachable without a session', async () => {
    // Bad body: proves the request reached the handler instead of `401 auth_required`.
    const response = await authRequiredApp.request('/api/v1/runner-enrollments/ren_x/preflight', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('invalid_request');
  });
});

describe('rendered commands', () => {
  const token = 'ren_test_token_value';
  const apiBase = 'http://localhost:8080';

  test('preflight posts to the enrollment token URL', () => {
    const script = preflightCommand(apiBase, token, 'linux');
    expect(script).toContain(`${apiBase}/api/v1/runner-enrollments/${token}/preflight`);
    expect(script).toContain('docker version');
    expect(script).toContain('git --version');
    expect(script).toContain('df -Pk');
    expect(script).toContain('curl');
  });

  test('install keeps the token in the environment, not in the arguments', () => {
    const command = installCommand({
      apiBase,
      token,
      name: 'Linux Runner 1',
      platform: 'linux',
      pool: 'default',
      labels: { gpu: 'false' },
      maxConcurrent: 2,
    });
    expect(command).toContain(`-e RUNNER_ENROLLMENT_TOKEN='${token}'`);
    expect(command).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(command).toContain('factory-runner-agent:local');
    expect(command).toContain('docker build -t factory-runner-agent:local');
    // The token must not be a positional argument of the container command.
    expect(command.split('\n').at(-1)).not.toContain(token);
    expect(command).toContain("--name 'factory-runner-linux-runner-1'");
  });
});
