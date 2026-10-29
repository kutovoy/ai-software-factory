import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app';
import { loadApiConfig } from '../src/config';
import { getFactoryDiff } from '../src/factories';

const repoRoot = resolve('.');
const config = loadApiConfig({
  ...process.env,
  FACTORY_ROOT: join(repoRoot, 'factories'),
  REPO_ROOT: repoRoot,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
});

const app = createApp(config);

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await app.request(path);
  return { status: response.status, body: await response.json() };
}

describe('GET /factories', () => {
  test('lists factories from FACTORY_ROOT with version metadata', async () => {
    const { status, body } = await get('/factories');
    expect(status).toBe(200);

    const names = body.factories.map((factory: { name: string }) => factory.name);
    expect(names).toContain('example');
    expect(names).toContain('example-lights-off');

    const example = body.factories.find((factory: { name: string }) => factory.name === 'example');
    expect(example.alias).toBe('Example');
    expect(example.repoCount).toBe(1);
    expect(example.valid).toBe(true);
    expect(example.errorCount).toBe(0);
    // Path-is-identity: the directory name is the key, not manifest.name.
    expect(example.manifestName).toBe('example');
    expect(example.version.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(example.version.shortCommit).toHaveLength(8);
    expect(example.version.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('GET /factories/:name', () => {
  test('returns the manifest, resolved gates and autonomy flags', async () => {
    const { status, body } = await get('/factories/example');
    expect(status).toBe(200);

    const factory = body.factory;
    expect(factory.name).toBe('example');
    expect(factory.manifest.mergePolicy).toBe('human');
    expect(factory.gates.stages.spec).toEqual({ stage: 'spec', gate: 'human', source: 'factory' });
    expect(factory.gates.stages.implement).toEqual({
      stage: 'implement',
      gate: 'agent',
      source: 'factory',
    });
    expect(factory.fullyAutonomous).toBe(false);
    expect(factory.benchmarkGateRequired).toBe(false);
    expect(factory.version.tag === null || /^factory-v\d+$/.test(factory.version.tag)).toBe(true);
  });

  test('lights-off factory is fully autonomous and needs a benchmark gate', async () => {
    const { status, body } = await get('/factories/example-lights-off');
    expect(status).toBe(200);

    const factory = body.factory;
    expect(factory.fullyAutonomous).toBe(true);
    expect(factory.benchmarkGateRequired).toBe(true);
    expect(factory.gates.mergePolicy).toBe('auto_on_green');
    for (const stage of Object.values(factory.gates.stages) as { gate: string }[]) {
      expect(stage.gate).toBe('agent');
    }
  });

  test('unknown factory is a 404 factory_not_found', async () => {
    const { status, body } = await get('/factories/does-not-exist');
    expect(status).toBe(404);
    expect(body.code).toBe('factory_not_found');
    expect(body.details.factory).toBe('does-not-exist');
  });

  test('an invalid factory name is rejected before touching the filesystem', async () => {
    const { status, body } = await get('/factories/..%2Fetc');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });
});

describe('GET /factories/:name/resources', () => {
  test('flattens the resource tree with kind, name, path and summary', async () => {
    const { status, body } = await get('/factories/example/resources');
    expect(status).toBe(200);

    expect(body.factory).toBe('example');
    expect(body.counts.agent).toBe(6);
    expect(body.counts.automation).toBe(1);
    expect(body.counts.scorer).toBe(1);
    expect(body.counts.runner).toBe(1);

    const foreman = body.resources.find(
      (resource: { kind: string; name: string }) =>
        resource.kind === 'agent' && resource.name === 'foreman',
    );
    expect(foreman.path).toBe('agents/foreman/agent.md');
    expect(foreman.format).toBe('markdown');
    expect(foreman.summary.length).toBeGreaterThan(0);
    // The normalised doc is projected too, so the Agents page can render role/tools
    // without a second route. Secret *names* only; a definition holds no values.
    expect(foreman.doc.role).toBe('foreman');
    expect(foreman.doc.tools.allow).toContain('read');
    expect(foreman.doc.spawnableBy).toEqual([]);

    const implement = body.resources.find(
      (resource: { kind: string; name: string }) =>
        resource.kind === 'agent' && resource.name === 'implement',
    );
    expect(implement.doc.harness.auth.secretName).toBe('OPENCODE_API_KEY');
    expect(implement.doc.tools.deny).toContain('git_push_force');
  });

  test('unknown factory is a 404 factory_not_found', async () => {
    const { status, body } = await get('/factories/nope/resources');
    expect(status).toBe(404);
    expect(body.code).toBe('factory_not_found');
  });
});

describe('GET /factories/:name/versions', () => {
  test('returns git history for the factory directory', async () => {
    const { status, body } = await get('/factories/example/versions');
    expect(status).toBe(200);
    expect(body.factory).toBe('example');
    expect(body.versions.length).toBeGreaterThan(0);

    const newestCommit = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '-1', '--format=%H', '--', 'factories/example'],
      { encoding: 'utf8' },
    ).trim();
    const newest = body.versions[0];
    expect(newest.commit).toBe(newestCommit);
    expect(newest.shortCommit).toHaveLength(8);
    expect(typeof newest.message).toBe('string');
    expect(newest.message.length).toBeGreaterThan(0);
    expect(newest.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('unknown factory is a 404 factory_not_found', async () => {
    const { status, body } = await get('/factories/nope/versions');
    expect(status).toBe(404);
    expect(body.code).toBe('factory_not_found');
  });
});

describe('GET /factories/:name/diff', () => {
  test('defaults to the previous commit touching the factory and returns a semantic diff', async () => {
    const { status, body } = await get('/factories/example/diff');
    expect(status).toBe(200);
    expect(body.factory).toBe('example');
    expect(body.to.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.diff).toHaveProperty('added');
    expect(body.diff).toHaveProperty('removed');
    expect(body.diff).toHaveProperty('changed');
    expect(typeof body.diff.isEmpty).toBe('boolean');
    expect(typeof body.text).toBe('string');
  });

  test('accepts explicit from/to refs', async () => {
    const { status, body } = await get('/factories/example/diff?from=HEAD&to=HEAD');
    expect(status).toBe(200);
    expect(body.from.commit).toBe(body.to.commit);
    expect(body.diff.isEmpty).toBe(true);
  });

  test('an unknown ref is a 400 invalid_request', async () => {
    const { status, body } = await get('/factories/example/diff?from=not-a-ref');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_request');
  });

  test('unknown factory is a 404 factory_not_found', async () => {
    const { status, body } = await get('/factories/nope/diff');
    expect(status).toBe(404);
    expect(body.code).toBe('factory_not_found');
  });
});

/* The repo's own factories have a single commit touching the definition, so the diff logic
 * is exercised against a scratch git repo where the definition actually changed. */
describe('getFactoryDiff (semantic diff against real git history)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'factory-diff-'));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const git = (args: string[]): string =>
    execFileSync('git', ['-C', scratch, ...args], { encoding: 'utf8' }).trim();

  function writeFactory(mergePolicy: string, extraAgent: boolean): void {
    const dir = join(scratch, 'factories', 'demo');
    mkdirSync(join(dir, 'agents', 'lead'), { recursive: true });
    mkdirSync(join(dir, 'runners'), { recursive: true });
    writeFileSync(join(dir, 'runners', 'local.yaml'), 'description: local runner\n');
    writeFileSync(
      join(dir, 'factory.yaml'),
      [
        'schemaVersion: v1alpha1',
        'name: demo',
        'mergePolicy: ' + mergePolicy,
        'repositories: [{owner: acme, name: api}]',
        'agentDefaults: {harness: {type: opencode, model: fake/model}, runner: local}',
        'gates: {spec: human}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'agents', 'lead', 'agent.md'),
      '---\nrole: foreman\n---\nLead the work.\n',
    );
    if (extraAgent) {
      mkdirSync(join(dir, 'agents', 'review'), { recursive: true });
      writeFileSync(
        join(dir, 'agents', 'review', 'agent.md'),
        '---\nrole: review\n---\nReview the work.\n',
      );
    }
  }

  test('detects added resources and changed fields between two commits', () => {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);

    writeFactory('human', false);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'factory v1']);

    writeFactory('auto_on_green', true);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'factory v2']);

    const scratchConfig = loadApiConfig({
      ...process.env,
      FACTORY_ROOT: join(scratch, 'factories'),
      REPO_ROOT: scratch,
      DATABASE_URL: config.databaseUrl,
    });

    const diff = getFactoryDiff(scratchConfig, 'demo', 'HEAD~1', 'HEAD');
    expect(diff.from.commit).toBe(git(['rev-parse', 'HEAD~1']));
    expect(diff.to.commit).toBe(git(['rev-parse', 'HEAD']));
    expect(diff.diff.isEmpty).toBe(false);
    expect(diff.diff.added).toEqual([{ kind: 'agent', name: 'review' }]);
    expect(diff.diff.changed.map((entry) => `${entry.kind}:${entry.name}`)).toContain(
      'factory:demo',
    );
    expect(diff.text).toContain('+ agent:review');
    expect(diff.text).toContain('/mergePolicy');
  });
});
