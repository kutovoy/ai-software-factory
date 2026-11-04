import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildValidationContract,
  workItemSchema,
  type ValidationContract,
  type WorkItem,
  type WorkItemEvent,
} from '@factory/core';
import { loadApiConfig } from '../src/config';
import { ApiError, toEnvelope } from '../src/errors';
import { getReadinessForApi } from '../src/readiness';
import { assertValidationComplete, projectValidation } from '../src/validation';

/**
 * Factory-engineering API contract (roadmap items 1, 2 and 4): the validation projection,
 * verify-gate enforcement and the readiness report. These are pure reads — no Postgres,
 * Temporal or model call.
 */

const repoRoot = resolve('.');
const workItemId = 'wi_01M6ASKQGPMZ8Q54YABS8YCWP3';
const definitionCommit = '0123456789abcdef0123456789abcdef01234567';

function contract(enforce: boolean): ValidationContract {
  return buildValidationContract({
    workItemId,
    factory: 'example',
    definitionCommit,
    createdAt: new Date().toISOString(),
    title: 'Fix the flaky verify stage',
    repoRoot,
    config: {
      enforce,
      checks: [
        {
          id: 'test',
          title: 'Unit tests',
          tier: 'unit',
          required: true,
          evidence: 'command',
          command: 'bun test',
        },
        {
          id: 'manual-acceptance',
          title: 'Manual acceptance',
          tier: 'manual',
          required: true,
          evidence: 'manual',
        },
      ],
    },
  });
}

function itemWith(validationContract: ValidationContract | null): WorkItem {
  return workItemSchema.parse({
    id: workItemId,
    factory: 'example',
    definitionCommit,
    title: 'Fix the flaky verify stage',
    stage: 'verify',
    type: 'task',
    source: 'manual',
    input: validationContract ? { validationContract } : {},
  });
}

function evidenceEvent(
  checks: { checkId: string; status: 'pass' | 'fail'; source: 'agent' }[],
): WorkItemEvent[] {
  return [
    {
      id: 1,
      workItemId,
      type: 'validation.evidence',
      stage: 'verify',
      actor: 'qa',
      payload: { contractId: workItemId, checks },
      createdAt: new Date().toISOString(),
    },
  ];
}

const passing = evidenceEvent([
  { checkId: 'test', status: 'pass', source: 'agent' },
  { checkId: 'manual-acceptance', status: 'pass', source: 'agent' },
]);

const incomplete = evidenceEvent([{ checkId: 'test', status: 'pass', source: 'agent' }]);

describe('validation projection', () => {
  test('complete evidence projects complete with no missing checks', () => {
    const item = itemWith(contract(true));
    const projection = projectValidation(item, passing);
    expect(projection).not.toBeNull();
    expect(projection?.complete).toBe(true);
    expect(projection?.missing).toEqual([]);
    expect(projection?.checks.map((check) => check.status)).toEqual(['pass', 'pass']);
    expect(() => assertValidationComplete(item, passing)).not.toThrow();
  });

  test('an enforced contract with missing evidence refuses approval', () => {
    const item = itemWith(contract(true));
    let error: unknown;
    try {
      assertValidationComplete(item, incomplete);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    const envelope = toEnvelope(error);
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('validation_incomplete');
    expect(envelope.body.details).toEqual({
      workItemId,
      missing: ['manual-acceptance'],
    });
  });

  test('an advisory contract never blocks approval', () => {
    const item = itemWith(contract(false));
    expect(() => assertValidationComplete(item, incomplete)).not.toThrow();
  });

  test('an item without a contract projects null and never blocks', () => {
    const item = itemWith(null);
    expect(projectValidation(item, passing)).toBeNull();
    expect(() => assertValidationComplete(item, passing)).not.toThrow();
  });

  test('a forge check can satisfy a required check without agent evidence', () => {
    const item = itemWith(contract(true));
    const events: WorkItemEvent[] = [
      {
        id: 2,
        workItemId,
        type: 'checks.recorded',
        stage: 'verify',
        actor: 'forge',
        payload: {
          green: true,
          checks: [
            { name: 'test', conclusion: 'success' },
            { name: 'manual-acceptance', conclusion: 'success' },
          ],
        },
        createdAt: new Date().toISOString(),
      },
    ];
    const projection = projectValidation(item, events);
    expect(projection?.complete).toBe(true);
    expect(projection?.checks.every((check) => check.source === 'forge')).toBe(true);
  });
});

describe('readiness report', () => {
  const config = loadApiConfig({
    ...process.env,
    FACTORY_ROOT: resolve(repoRoot, 'factories'),
    REPO_ROOT: repoRoot,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://factory:factory@localhost:5433/factory',
  });

  test('GET readiness is deterministic and reports score, status, sections and checks', async () => {
    const report = await getReadinessForApi(config, 'example');

    expect(report.root).toBe(repoRoot);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(['ready', 'warn', 'not_ready']).toContain(report.status);
    expect(report.thresholds).toEqual({ ready: 80, warn: 60 });

    expect(report.sections.map((section) => section.id)).toEqual(['repository', 'factory']);
    for (const section of report.sections) {
      expect(section.checks.length).toBeGreaterThan(0);
      for (const check of section.checks) {
        expect(check.id.length).toBeGreaterThan(0);
        expect(check.label.length).toBeGreaterThan(0);
        expect(typeof check.passed).toBe('boolean');
        expect(check.evidence.length).toBeGreaterThan(0);
        expect(check.remediation.length).toBeGreaterThan(0);
      }
    }

    expect(report.checks.length).toBe(
      report.sections.reduce((total, section) => total + section.checks.length, 0),
    );
    expect(report.checks.map((check) => check.id)).toContain('qa-agent');
    expect(report.summary).toContain(`${report.score}/100`);

    // Deterministic: the same checkout + definition yields the same report (no model call).
    const again = await getReadinessForApi(config, 'example');
    expect(again.score).toBe(report.score);
    expect(again.status).toBe(report.status);
    expect(again.checks).toEqual(report.checks);
  });
});
