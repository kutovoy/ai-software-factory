import { describe, expect, test } from 'bun:test';
import { ApiError, toEnvelope } from '../src/errors';
import { mapRunnerName } from '../src/runs';
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
