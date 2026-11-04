import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FactoryDefinition, Resource } from '../src/loader/load';
import { scanReadiness } from '../src/readiness';
import { factorySchema } from '../src/schema/factory';
import { tempDir } from './helpers';

function write(root: string, relPath: string, content = ''): void {
  const path = join(root, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function resource(kind: Resource['kind'], name: string, doc: unknown = {}): Resource {
  return {
    kind,
    name,
    path: `${kind}s/${name}.yaml`,
    format: 'yaml',
    doc,
    body: '',
  };
}

function definition(overrides: Record<string, unknown> = {}, resources: Resource[] = []): FactoryDefinition {
  const manifest = factorySchema.parse({
    schemaVersion: 'v1alpha1',
    name: 'fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { model: 'test-model' },
    gates: {},
    mergePolicy: 'human',
    ...overrides,
  });
  return { root: '/tmp/factory', manifest, resources };
}

/** A repository that passes every repository check. */
function readyRepository(): string {
  const root = tempDir('factory-readiness-');
  write(
    root,
    'package.json',
    JSON.stringify({
      scripts: {
        lint: 'eslint .',
        build: 'vite build',
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
      devDependencies: {
        eslint: '^9.0.0',
        typescript: '^5.7.0',
        vitest: '^2.0.0',
        '@opentelemetry/api': '^1.0.0',
        helmet: '^7.0.0',
      },
    }),
  );
  write(root, 'tsconfig.json', '{}');
  write(root, 'README.md', '# Fixture');
  write(root, '.env.example', 'TOKEN=');
  write(root, 'src/telemetry.ts', 'export {};');
  write(root, 'SECURITY.md', '# Security');
  write(root, 'TODO.md', '- [ ] task');
  return root;
}

/** A factory definition that passes every factory check. */
function readyDefinition(): FactoryDefinition {
  return definition(
    {
      stages: [{ name: 'review', reviewers: 2 }],
      gates: { review: 'human' },
      mergePolicy: 'human',
      agentVerdict: 'required',
      secrets: ['TOKEN'],
      mcpServers: { github: { command: 'github-mcp' } },
    },
    [
      resource('agent', 'qa-agent', { role: 'verify', secrets: ['TOKEN'] }),
      resource('scorer', 'quality'),
      resource('benchmark', 'smoke-suite'),
    ],
  );
}

describe('readiness scan', () => {
  test('scores a ready repository and factory at 100', () => {
    const report = scanReadiness({
      repoRoot: readyRepository(),
      definition: readyDefinition(),
    });

    expect(report.score).toBe(100);
    expect(report.status).toBe('ready');
    expect(report.thresholds).toEqual({ ready: 80, warn: 60 });
    expect(report.sections.map((section) => section.id)).toEqual(['repository', 'factory']);
    expect(report.checks).toHaveLength(18);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.checks.every((check) => check.evidence.length > 0)).toBe(true);
    expect(report.checks.every((check) => check.remediation.length > 0)).toBe(true);
    expect(report.summary).toContain('ready');
  });

  test('reports explicit not-found evidence for an empty factory and repository', () => {
    const root = tempDir('factory-readiness-');
    const report = scanReadiness({
      repoRoot: root,
      definition: definition({ mergePolicy: 'disabled' }),
    });

    expect(report.status).toBe('not_ready');
    expect(report.score).toBe(0);
    const failed = report.checks.filter((check) => !check.passed);
    expect(failed.length).toBe(report.checks.length);
    for (const check of failed) {
      expect(check.evidence).toContain('not found');
      expect(check.remediation.length).toBeGreaterThan(10);
    }
  });

  test('applies custom thresholds to the same score', () => {
    const root = readyRepository();
    const base = definition({ mergePolicy: 'disabled' });

    const defaultReport = scanReadiness({ repoRoot: root, definition: base });
    expect(defaultReport.score).toBeCloseTo(47.6, 1);
    expect(defaultReport.status).toBe('not_ready');

    const warnReport = scanReadiness({
      repoRoot: root,
      definition: base,
      thresholds: { ready: 60, warn: 40 },
    });
    expect(warnReport.status).toBe('warn');
    expect(warnReport.thresholds).toEqual({ ready: 60, warn: 40 });

    const readyReport = scanReadiness({
      repoRoot: root,
      definition: base,
      thresholds: { ready: 40, warn: 30 },
    });
    expect(readyReport.status).toBe('ready');
  });

  test('detects QA agents, reviewers, gates and factory resources', () => {
    const report = scanReadiness({
      repoRoot: readyRepository(),
      definition: readyDefinition(),
    });
    const byId = new Map(report.checks.map((check) => [check.id, check]));

    expect(byId.get('qa-agent')?.evidence).toContain('qa-agent');
    expect(byId.get('reviewers')?.evidence).toContain('2 reviewers');
    expect(byId.get('gates')?.evidence).toContain('review=human');
    expect(byId.get('agent-verdict')?.evidence).toContain('required');
    expect(byId.get('scorers')?.evidence).toContain('quality');
    expect(byId.get('benchmarks')?.evidence).toContain('smoke-suite');
    expect(byId.get('secrets')?.evidence).toContain('TOKEN');
    expect(byId.get('mcp')?.passed).toBe(true);
  });

  test('section scores are weighted per section', () => {
    const report = scanReadiness({
      repoRoot: readyRepository(),
      definition: definition({ mergePolicy: 'disabled' }),
    });
    const repository = report.sections.find((section) => section.id === 'repository')!;
    const factory = report.sections.find((section) => section.id === 'factory')!;

    expect(repository.score).toBe(100);
    expect(factory.score).toBe(0);
  });
});
