import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VALIDATION_TIERS,
  buildValidationContract,
  evaluateValidationContract,
  inferValidationChecks,
  parseValidationEvidence,
  validationCheckSchema,
  validationEvidenceSchema,
  type ValidationCheck,
  type ValidationContract,
} from '../src/validation';
import { tempDir } from './helpers';

function write(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function contractWith(checks: ValidationCheck[]): ValidationContract {
  return {
    version: 'v1alpha1',
    workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    factory: 'example',
    definitionCommit: 'abcdef1',
    createdAt: '2026-10-02T00:00:00Z',
    enforce: true,
    checks,
    risks: [],
    source: 'factory',
  };
}

const commandCheck: ValidationCheck = {
  id: 'typecheck',
  title: 'Typecheck',
  tier: 'unit',
  required: true,
  evidence: 'command',
  command: 'bun run typecheck',
};

describe('validation contract builder', () => {
  test('infers checks from package.json scripts and Playwright', () => {
    const root = tempDir('factory-validation-');
    write(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
          build: 'vite build',
        },
        devDependencies: { '@playwright/test': '^1.0.0' },
      }),
    );
    write(root, 'playwright.config.ts', 'export default {};\n');

    const checks = inferValidationChecks(root);
    expect(checks.map((check) => check.id)).toEqual(['typecheck', 'lint', 'test', 'build', 'e2e']);
    expect(checks.every((check) => check.evidence === 'command')).toBe(true);
    expect(checks.every((check) => check.command?.includes('run') || check.command?.includes('playwright'))).toBe(true);
  });

  test('builds an inferred contract plus a required manual acceptance check', () => {
    const root = tempDir('factory-validation-');
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

    const contract = buildValidationContract({
      workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      factory: 'example',
      definitionCommit: 'abcdef1',
      createdAt: '2026-10-02T00:00:00Z',
      title: 'Add billing export',
      repoRoot: root,
    });

    expect(contract.source).toBe('inferred');
    expect(contract.enforce).toBe(false);
    expect(contract.checks.map((check) => check.id)).toEqual(['test', 'manual-acceptance']);
    const manual = contract.checks.find((check) => check.id === 'manual-acceptance')!;
    expect(manual.tier).toBe('manual');
    expect(manual.required).toBe(true);
    expect(manual.title).toContain('Add billing export');
  });

  test('explicit factory checks win over inference', () => {
    const root = tempDir('factory-validation-');
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));
    const explicit: ValidationCheck = {
      id: 'smoke',
      title: 'Smoke test',
      tier: 'integration',
      required: true,
      evidence: 'command',
      command: 'bun run smoke',
    };

    const contract = buildValidationContract({
      workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      factory: 'example',
      definitionCommit: 'abcdef1',
      createdAt: '2026-10-02T00:00:00Z',
      title: 'Add billing export',
      repoRoot: root,
      config: { enforce: true, checks: [explicit] },
    });

    expect(contract.source).toBe('factory');
    expect(contract.enforce).toBe(true);
    expect(contract.checks).toEqual([explicit]);
  });

  test('includes architecture and maintainability tiers', () => {
    expect(VALIDATION_TIERS).toContain('architecture');
    expect(VALIDATION_TIERS).toContain('maintainability');
  });

  test('infers architecture and maintainability checks after build/e2e', () => {
    const root = tempDir('factory-validation-');
    write(
      root,
      'package.json',
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
          'arch:check': 'dependency-cruiser src',
          jscpd: 'jscpd src',
        },
      }),
    );
    write(root, 'playwright.config.ts', 'export default {};\n');
    write(root, 'bun.lock', '');

    const checks = inferValidationChecks(root);
    expect(checks.map((check) => check.id)).toEqual([
      'typecheck',
      'test',
      'e2e',
      'architecture',
      'maintainability',
    ]);
    const architecture = checks.find((check) => check.id === 'architecture')!;
    expect(architecture.tier).toBe('architecture');
    expect(architecture.title).toBe('Architecture boundaries');
    expect(architecture.command).toBe('bun run arch:check');
    expect(architecture.expected).toBe('exit code 0');
    const maintainability = checks.find((check) => check.id === 'maintainability')!;
    expect(maintainability.tier).toBe('maintainability');
    expect(maintainability.title).toBe('Maintainability');
    expect(maintainability.command).toBe('bun run jscpd');
  });

  test('accepts the alternate architecture and maintainability script names', () => {
    const root = tempDir('factory-validation-');
    write(
      root,
      'package.json',
      JSON.stringify({ scripts: { depcruise: 'depcruise src', quality: 'tsc && eslint' } }),
    );
    write(root, 'bun.lock', '');

    const checks = inferValidationChecks(root);
    expect(checks.map((check) => check.id)).toEqual(['architecture', 'maintainability']);
    expect(checks[0].command).toBe('bun run depcruise');
    expect(checks[1].command).toBe('bun run quality');
  });

  test('does not invent quality checks without scripts', () => {
    const root = tempDir('factory-validation-');
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest run' } }));

    const checks = inferValidationChecks(root);
    expect(checks.map((check) => check.id)).toEqual(['test']);
  });

  test('always returns at least one check', () => {
    const root = tempDir('factory-validation-');
    const contract = buildValidationContract({
      workItemId: 'wi_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      factory: 'example',
      definitionCommit: 'abcdef1',
      createdAt: '2026-10-02T00:00:00Z',
      title: 'Empty repository',
      repoRoot: root,
    });
    expect(contract.checks.length).toBeGreaterThanOrEqual(1);
    expect(contract.checks[0].id).toBe('manual-acceptance');
  });
});

describe('validation evidence parsing', () => {
  test('uses the last fenced json block with a validation array', () => {
    const text = [
      'Here is an early report:',
      '```json',
      '{"validation":[{"id":"lint","status":"fail","evidence":"eslint failed"}]}',
      '```',
      'And the final report:',
      '```json',
      '{"validation":[{"id":"test","status":"pass","evidence":"bun test"}]}',
      '```',
    ].join('\n');

    expect(parseValidationEvidence(text)).toEqual([
      { checkId: 'test', status: 'pass', source: 'agent', detail: 'bun test' },
    ]);
  });

  test('ignores malformed entries inside the chosen block', () => {
    const text = [
      '```json',
      '{"validation":[{"id":"lint","status":"maybe"},{"status":"pass"},{"id":"","status":"pass"}]}',
      '```',
    ].join('\n');

    expect(parseValidationEvidence(text)).toEqual([]);
  });

  test('falls back past a block that is not valid JSON', () => {
    const text = [
      '```json',
      '{"validation":[{"id":"test","status":"pass","evidence":"bun test"}]}',
      '```',
      '```json',
      '{not valid json',
      '```',
    ].join('\n');

    expect(parseValidationEvidence(text)).toEqual([
      { checkId: 'test', status: 'pass', source: 'agent', detail: 'bun test' },
    ]);
  });

  test('returns an empty list when no block exists', () => {
    expect(parseValidationEvidence('no evidence here')).toEqual([]);
    expect(parseValidationEvidence('')).toEqual([]);
  });

  test('parses finite metrics and preserves them', () => {
    const text = [
      '```json',
      '{"validation":[{"id":"architecture","status":"pass","evidence":"no cycles",',
      '"metrics":{"cycles":0,"duplicationPercent":2.5,"ignored":"text","bad":null}}]}',
      '```',
    ].join('\n');

    expect(parseValidationEvidence(text)).toEqual([
      {
        checkId: 'architecture',
        status: 'pass',
        source: 'agent',
        detail: 'no cycles',
        metrics: { cycles: 0, duplicationPercent: 2.5 },
      },
    ]);
  });

  test('omits metrics when none are finite', () => {
    const text =
      '```json\n{"validation":[{"id":"test","status":"pass","metrics":{"bad":null}}]}\n```';
    expect(parseValidationEvidence(text)).toEqual([
      { checkId: 'test', status: 'pass', source: 'agent' },
    ]);
  });

  test('schema mirrors optional thresholds and metrics', () => {
    const check = {
      id: 'maintainability',
      title: 'Maintainability',
      tier: 'maintainability',
      required: true,
      evidence: 'command',
      thresholds: { maxDuplicationPercent: 3 },
    };
    expect(validationCheckSchema.safeParse(check).success).toBe(true);
    expect(
      validationCheckSchema.safeParse({ ...check, thresholds: { bad: Number.NaN } }).success,
    ).toBe(false);

    const evidence = {
      checkId: 'maintainability',
      status: 'pass',
      source: 'agent',
      metrics: { duplicationPercent: 2 },
    };
    expect(validationEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      validationEvidenceSchema.safeParse({ ...evidence, metrics: { bad: Number.POSITIVE_INFINITY } })
        .success,
    ).toBe(false);
  });
});

describe('validation contract evaluation', () => {
  test('agent evidence wins by check id', () => {
    const contract = contractWith([commandCheck]);
    const projection = evaluateValidationContract(
      contract,
      [{ checkId: 'typecheck', status: 'fail', source: 'agent', detail: 'tsc error' }],
      [{ name: 'typecheck', conclusion: 'success' }],
    );

    expect(projection.checks[0].status).toBe('fail');
    expect(projection.checks[0].source).toBe('agent');
    expect(projection.complete).toBe(false);
    expect(projection.missing).toEqual(['typecheck']);
  });

  test('forge checks map by id or title and pass on success/skipped', () => {
    const contract = contractWith([
      commandCheck,
      {
        id: 'manual-acceptance',
        title: 'Manual acceptance',
        tier: 'manual',
        required: false,
        evidence: 'manual',
      },
    ]);
    const projection = evaluateValidationContract(
      contract,
      [],
      [
        { name: 'Typecheck', conclusion: 'success' },
        { name: 'manual acceptance', status: 'skipped' },
      ],
    );

    expect(projection.complete).toBe(true);
    expect(projection.missing).toEqual([]);
    expect(projection.checks.map((check) => check.source)).toEqual(['forge', 'forge']);
  });

  test('required checks that fail or are missing make the contract incomplete', () => {
    const contract = contractWith([
      commandCheck,
      {
        id: 'e2e',
        title: 'End-to-end tests',
        tier: 'e2e',
        required: true,
        evidence: 'command',
      },
      {
        id: 'optional-artifact',
        title: 'Optional artifact',
        tier: 'integration',
        required: false,
        evidence: 'artifact',
      },
    ]);
    const projection = evaluateValidationContract(contract, [], [
      { name: 'typecheck', conclusion: 'failure' },
    ]);

    expect(projection.complete).toBe(false);
    expect(projection.missing).toEqual(['typecheck', 'e2e']);
    expect(projection.checks.map((check) => check.status)).toEqual(['fail', 'missing', 'missing']);
  });
});
