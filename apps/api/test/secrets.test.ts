import { describe, expect, test } from 'bun:test';
import { factoryIdOf, req } from './helpers';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { collectAllSecretReferences } from '../src/secrets';

/**
 * Secret registry + MCP rejection codes (change `add-secrets-and-mcp`, task 3.5).
 *
 * Every case here is refused *before* a database write, so CI (no Postgres) covers the
 * stable codes. The persistence paths live in `secrets.integration.test.ts`.
 */

const repoRoot = resolve('.');
const config = loadApiConfig({
  ...process.env,
  FACTORY_ROOT: join(repoRoot, 'factories'),
  REPO_ROOT: repoRoot,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
});

const app = createApp(config);

const JSON_HEADERS = { 'content-type': 'application/json' };

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await req(app, path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function del(path: string): Promise<{ status: number; body: any }> {
  const response = await req(app, path, { method: 'DELETE' });
  return { status: response.status, body: await response.json() };
}

describe('secret registry rejection codes', () => {
  test('a submitted value is refused with secret_value_rejected', async () => {
    const { status, body } = await post('/secrets', {
      name: 'GITHUB_TOKEN',
      value: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('secret_value_rejected');
    expect(body.message).toContain('names');
  });

  test('rotate refuses a value too', async () => {
    const { status, body } = await post('/secrets/GITHUB_TOKEN/rotate', {
      value: 'sk-abcdefghijklmnop',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('secret_value_rejected');
  });

  test('an invalid secret name is rejected before touching the registry', async () => {
    const { status, body } = await post('/secrets', { name: 'not a name' });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('deleting a secret a definition still references is refused with secret_in_use', async () => {
    // factories/example declares `GITHUB_TOKEN` for the github MCP server.
    const references = (await collectAllSecretReferences(config)).filter(
      (reference) => reference.name === 'GITHUB_TOKEN',
    );
    expect(references.length).toBeGreaterThan(0);

    const { status, body } = await del('/secrets/GITHUB_TOKEN');
    expect(status).toBe(409);
    expect(body.code).toBe('secret_in_use');
    expect(body.details.references[0]).toMatchObject({ kind: 'mcp', resource: 'mcp:github' });
  });

  test('a secret name with no references is still parsed as a name', async () => {
    const { status, body } = await del('/secrets/not%20a%20name');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });
});

describe('MCP registry rejection codes', () => {
  test('registering an undeclared server is refused with unknown_mcp_server', async () => {
    const id = await factoryIdOf(app, 'example');
    const { status, body } = await post(`/factories/${id}/mcp`, {
      servers: [{ name: 'not-declared' }],
    });
    expect(status).toBe(422);
    expect(body.code).toBe('unknown_mcp_server');
    expect(body.details.server).toBe('not-declared');
    expect(body.details.declared).toContain('github');
  });

  test('binding an unknown server names the agent and the server', async () => {
    const id = await factoryIdOf(app, 'example');
    const { status, body } = await post(`/factories/${id}/mcp`, {
      bindings: [{ agent: 'implement', server: 'not-declared' }],
    });
    expect(status).toBe(422);
    expect(body.code).toBe('unknown_mcp_server');
    expect(body.details.agent).toBe('implement');
    expect(body.details.server).toBe('not-declared');
  });

  test('binding an unknown agent is refused with unknown_agent', async () => {
    const id = await factoryIdOf(app, 'example');
    const { status, body } = await post(`/factories/${id}/mcp`, {
      bindings: [{ agent: 'ghost', server: 'github' }],
    });
    expect(status).toBe(422);
    expect(body.code).toBe('unknown_agent');
  });

  test('a transport that contradicts the declaration is an invalid_request', async () => {
    const id = await factoryIdOf(app, 'example');
    const { status, body } = await post(`/factories/${id}/mcp`, {
      servers: [{ name: 'github', transport: 'http' }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('testing an undeclared server is a 404 mcp_server_not_found', async () => {
    const id = await factoryIdOf(app, 'example');
    const { status, body } = await post(`/factories/${id}/mcp/not-declared/test`, {});
    expect(status).toBe(404);
    expect(body.code).toBe('mcp_server_not_found');
  });

  test('an unknown factory id is a 404 factory_not_found', async () => {
    const { status, body } = await post('/factories/fac_01M6D9K2B2J79P0M2KE28RY704/mcp/whatever/test', {});
    expect(status).toBe(404);
    expect(body.code).toBe('factory_not_found');
  });
});
