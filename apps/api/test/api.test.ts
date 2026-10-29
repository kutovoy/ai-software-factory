import { describe, expect, test } from 'bun:test';
import {
  autonomyRefused,
  gateNotFound,
  invalidStageGraph,
  spawnNotAllowed,
  workItemNotFound,
  ApiError,
  toEnvelope,
} from '../src/errors';
import { mapRunnerName, resolveRunDefaults } from '../src/runs';
import { factorySchema } from '@factory/core';
import { redact } from '../src/logger';

describe('error envelope', () => {
  test('ApiError maps to {code, message, details?}', () => {
    const envelope = toEnvelope(new ApiError('run_not_found', 404, 'nope', { runId: 'r1' }));
    expect(envelope.status).toBe(404);
    expect(envelope.body).toEqual({ code: 'run_not_found', message: 'nope', details: { runId: 'r1' } });
  });

  test('details are omitted when absent', () => {
    const envelope = toEnvelope(new ApiError('invalid_request', 400, 'bad'));
    expect(envelope.body).toEqual({ code: 'invalid_request', message: 'bad' });
  });

  test('unknown errors become internal_error', () => {
    const envelope = toEnvelope(new Error('boom'));
    expect(envelope.status).toBe(500);
    expect(envelope.body.code).toBe('internal_error');
  });
});

describe('runner name mapping', () => {
  test('definition runner names map to backends', () => {
    expect(mapRunnerName('local-docker')).toBe('local-docker');
    expect(mapRunnerName('local-process')).toBe('local-process');
    expect(mapRunnerName('local')).toBe('local-process');
    expect(mapRunnerName(undefined)).toBe('local-docker');
    expect(mapRunnerName('weird-runner')).toBe('local-docker');
  });
});

describe('log redaction', () => {
  test('secret-ish keys are redacted, prompts are not logged by callers', () => {
    const fields = redact({
      api_key: 'sk-123',
      authorization: 'Bearer x',
      token: 'rsk_abc',
      runId: 'run_1',
    });
    expect(fields.api_key).toBe('[redacted]');
    expect(fields.authorization).toBe('[redacted]');
    expect(fields.token).toBe('[redacted]');
    expect(fields.runId).toBe('run_1');
  });
});

describe('factory loop error envelope', () => {
  test('invalid_stage_graph is 422 and names the offending node', () => {
    const envelope = toEnvelope(
      invalidStageGraph('deploy', 'unknown stage "deploy" (allowed: triage, spec, ...)'),
    );
    expect(envelope.status).toBe(422);
    expect(envelope.body.code).toBe('invalid_stage_graph');
    expect(envelope.body.details).toEqual({ node: 'deploy' });
  });

  test('spawn_not_allowed is 409', () => {
    const envelope = toEnvelope(spawnNotAllowed('spec', 'spec', 'foreman'));
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('spawn_not_allowed');
    expect(envelope.body.details).toMatchObject({ stage: 'spec', agent: 'spec', spawner: 'foreman' });
  });

  test('autonomy_refused is 409 and carries the benchmark-gate state', () => {
    const envelope = toEnvelope(
      autonomyRefused('benchmark gate required', {
        benchmarkGateRequired: true,
        benchmarkGateSatisfied: false,
      }),
    );
    expect(envelope.status).toBe(409);
    expect(envelope.body.code).toBe('autonomy_refused');
    expect(envelope.body.details).toEqual({
      benchmarkGateRequired: true,
      benchmarkGateSatisfied: false,
    });
  });

  test('work item and gate lookups are 404', () => {
    expect(toEnvelope(workItemNotFound('wi_x')).status).toBe(404);
    expect(toEnvelope(gateNotFound('wi_x', 'spec')).body.code).toBe('gate_not_found');
  });
});

describe('run defaults', () => {
  const manifest = factorySchema.parse({
    schemaVersion: 'v1alpha1',
    name: 'fixture',
    repositories: [{ owner: 'acme', name: 'api' }],
    agentDefaults: { harness: { type: 'opencode', model: 'openai/gpt-5' }, runner: 'local-docker' },
    gates: { spec: 'human' },
    mergePolicy: 'human',
  });

  test('the fake harness always runs on the fake runner', () => {
    const defaults = resolveRunDefaults(manifest, { harness: 'fake' });
    expect(defaults.harness).toBe('fake');
    expect(defaults.runner).toBe('fake');
    // The declared model is kept; the fake adapter ignores it.
    expect(defaults.model).toBe('openai/gpt-5');
  });

  test('explicit values win over definition defaults', () => {
    const defaults = resolveRunDefaults(manifest, { model: 'openai/gpt-5-mini', runner: 'local-process' });
    expect(defaults.harness).toBe('opencode');
    expect(defaults.model).toBe('openai/gpt-5-mini');
    expect(defaults.runner).toBe('local-process');
  });
});
