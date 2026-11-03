import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  declaredMcpServers,
  loadDefinition,
  loadOrThrow,
  looksLikeInlineSecret,
  resolveMcpWiring,
  mcpServerGlob,
  collectSecretReferences,
} from '../src/index';
import { EXAMPLE, tempDir } from './helpers';

// Pin model env refs so validation findings do not depend on the host environment
// (CI has no .env; locally Bun loads one). model.test.ts covers the unset case.
const MODEL_ENV = {
  FACTORY_MODEL: 'test-model',
  FACTORY_SMALL_MODEL: 'test-model',
  FACTORY_REVIEW_MODEL: 'test-model',
};

/**
 * MCP declaration + per-agent binding (change `add-secrets-and-mcp`, spec
 * `mcp-integration`). These tests pin the observable validation codes and the resolved
 * wiring the adapter receives — names and globs only, never values.
 */

describe('MCP declaration', () => {
  it('declares the example factory server and binds one agent', () => {
    const definition = loadOrThrow(EXAMPLE);
    const servers = declaredMcpServers(definition.manifest);
    expect(servers.map((server) => server.name)).toContain('github');

    const github = servers.find((server) => server.name === 'github');
    expect(github?.transport).toBe('stdio');
    expect(github?.command).toBe('github-mcp');
    // Credentials are references: env maps a runtime key to a secret *name*.
    expect(github?.env).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
  });

  it('normalises the legacy mcpServers map into a server declaration', () => {
    const definition = loadOrThrow(join(EXAMPLE, '..', 'example-lights-off'));
    const servers = declaredMcpServers(definition.manifest);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'github', transport: 'stdio', command: 'github-mcp' });
  });

  it('rejects an unknown transport with invalid_value', () => {
    const dir = tempDir();
    writeFactory(dir, [
      'mcp:',
      '  servers:',
      '    - name: github',
      '      transport: socket',
      '      command: github-mcp',
    ]);
    const { definition, errors } = loadDefinition(dir);
    expect(definition).toBeNull();
    expect(errors.map((error) => error.code)).toContain('invalid_value');
  });

  it('rejects a stdio server without a command', () => {
    const dir = tempDir();
    writeFactory(dir, ['mcp:', '  servers:', '    - name: github', '      transport: stdio']);
    const { errors } = loadDefinition(dir);
    expect(errors.map((error) => error.code)).toContain('missing_field');
  });

  it('rejects an http server without a url and accepts a url-only server', () => {
    const dir = tempDir();
    writeFactory(dir, ['mcp:', '  servers:', '    - name: docs', '      transport: http']);
    expect(loadDefinition(dir).errors.map((error) => error.code)).toContain('missing_field');

    const ok = tempDir();
    writeFactory(ok, [
      'mcp:',
      '  servers:',
      '    - name: docs',
      '      transport: http',
      '      url: https://mcp.example.com/mcp',
      '      headers:',
      '        Authorization: DOCS_MCP_TOKEN',
    ]);
    const loaded = loadDefinition(ok);
    expect(loaded.definition).not.toBeNull();
    expect(loaded.errors).toEqual([]);
  });

  it('rejects credential-looking literals with secret_inline_rejected', () => {
    expect(looksLikeInlineSecret('sk-abcdefghijklmnop')).toBe(true);
    expect(looksLikeInlineSecret('ghp_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeInlineSecret('xoxb-1234567890-abcdefghij')).toBe(true);
    expect(looksLikeInlineSecret('GITHUB_TOKEN')).toBe(false);
    expect(looksLikeInlineSecret('github-mcp')).toBe(false);

    const dir = tempDir();
    writeFactory(dir, [
      'mcp:',
      '  servers:',
      '    - name: github',
      '      transport: stdio',
      '      command: github-mcp',
      '      args:',
      '        - sk-abcdefghijklmnop',
    ]);
    const { errors } = loadDefinition(dir);
    expect(errors.map((error) => error.code)).toContain('secret_inline_rejected');
    expect(errors.find((error) => error.code === 'secret_inline_rejected')?.pointer).toBe(
      '/mcp/servers/0/args/0',
    );
  });

  it('rejects a duplicate server declaration', () => {
    const dir = tempDir();
    writeFactory(dir, [
      'mcp:',
      '  servers:',
      '    - name: github',
      '      transport: stdio',
      '      command: github-mcp',
      '    - name: github',
      '      transport: stdio',
      '      command: github-mcp',
    ]);
    expect(loadDefinition(dir).errors.map((error) => error.code)).toContain('duplicate_identity');
  });
});

describe('per-agent binding', () => {
  it('rejects a binding to an undeclared server with unknown_mcp_server', () => {
    const dir = tempDir();
    writeFactory(dir, [
      'mcp:',
      '  servers:',
      '    - name: github',
      '      transport: stdio',
      '      command: github-mcp',
    ]);
    mkdirSync(join(dir, 'agents', 'lead'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'lead', 'agent.md'),
      '---\nrole: foreman\nmcp:\n  - jira\n---\nRoute the work.\n',
    );

    const { errors } = loadDefinition(dir);
    const unknown = errors.find((error) => error.code === 'unknown_mcp_server');
    expect(unknown).toBeDefined();
    expect(unknown?.message).toContain('lead');
    expect(unknown?.message).toContain('jira');
  });

  it('resolves allow globs for bound servers and deny globs for the rest', () => {
    const definition = loadOrThrow(EXAMPLE);
    const implement = resolveMcpWiring(definition, 'implement');
    expect(implement.agent).toBe('implement');
    expect(implement.bound).toEqual(['github']);
    expect(implement.servers.map((server) => server.name)).toEqual(['github']);
    expect(implement.permissions).toEqual({ [mcpServerGlob('github')]: 'allow' });

    const review = resolveMcpWiring(definition, 'review');
    expect(review.bound).toEqual([]);
    expect(review.servers).toEqual([]);
    expect(review.permissions).toEqual({ [mcpServerGlob('github')]: 'deny' });
  });

  it('resolves to no servers when the run names no agent', () => {
    const wiring = resolveMcpWiring(loadOrThrow(EXAMPLE), null);
    expect(wiring.agent).toBeNull();
    expect(wiring.servers).toEqual([]);
    expect(wiring.bound).toEqual([]);
    expect(wiring.permissions).toEqual({ 'github*': 'deny' });
  });

  it('never carries a secret value: env and headers are names', () => {
    const wiring = resolveMcpWiring(loadOrThrow(EXAMPLE), 'implement');
    const serialised = JSON.stringify(wiring);
    expect(serialised).toContain('GITHUB_TOKEN');
    expect(serialised).not.toMatch(/ghp_|sk-[A-Za-z0-9]{8,}|xox[baprs]-/);
  });
});

describe('secret references and warnings', () => {
  it('collects every referenced secret name with its pointer', () => {
    const definition = loadOrThrow(EXAMPLE);
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as never }));
    const references = collectSecretReferences(definition.manifest, agents);

    expect(references.map((reference) => reference.name)).toContain('OPENCODE_API_KEY');
    const mcpReference = references.find((reference) => reference.kind === 'mcp');
    expect(mcpReference).toMatchObject({
      name: 'GITHUB_TOKEN',
      resource: 'mcp:github',
      pointer: '/mcp/servers/github/env/GITHUB_TOKEN',
    });
    expect(references.find((reference) => reference.kind === 'agent')?.resource).toBe('implement');
  });

  it('warns secret_unregistered without failing validation', () => {
    const { definition, errors, warnings } = loadDefinition(EXAMPLE, {
      registeredSecrets: ['OPENCODE_API_KEY'],
      env: MODEL_ENV,
    });
    expect(errors).toEqual([]);
    expect(definition).not.toBeNull();
    expect(warnings.map((warning) => warning.code)).toEqual(['secret_unregistered']);
    expect(warnings[0]?.message).toContain('GITHUB_TOKEN');
  });

  it('does not warn when the registry covers every reference', () => {
    const { warnings } = loadDefinition(EXAMPLE, {
      registeredSecrets: ['OPENCODE_API_KEY', 'GITHUB_TOKEN'],
      env: MODEL_ENV,
    });
    expect(warnings).toEqual([]);
  });
});

function writeFactory(dir: string, mcpLines: string[]): void {
  writeFileSync(
    join(dir, 'factory.yaml'),
    [
      'schemaVersion: v1alpha1',
      'name: fixture',
      'repositories:',
      '  - owner: acme',
      '    name: api',
      'agentDefaults:',
      '  model: test-model',
      'gates:',
      '  review: human',
      'mergePolicy: human',
      ...mcpLines,
      '',
    ].join('\n'),
  );
}
