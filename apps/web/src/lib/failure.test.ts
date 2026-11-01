import { describe, expect, test } from 'bun:test';
import { failureCode, failureMessage, remediationFor, temporalWorkflowUrl } from './failure';

/**
 * The run page's failure helpers (spec `run-lifecycle` › Failure panel).
 *
 * The API stores `describeFailure()` output as `<code>: <message>` and no schema carries the
 * code, so the panel parses the prefix; these tests pin both spellings (factory snake_case
 * codes and Node ALL-CAPS codes) and the wrapper fallback for rows written before the fix.
 */

describe('failureCode', () => {
  test('reads a factory code', () => {
    expect(failureCode('docker_unavailable: docker CLI/server is not available')).toBe(
      'docker_unavailable',
    );
  });

  test('reads a Node system code', () => {
    expect(failureCode('ECONNRESET: The socket connection was closed unexpectedly')).toBe(
      'ECONNRESET',
    );
  });

  test('does not mistake a class name for a code', () => {
    expect(failureCode('Error: boom')).toBeUndefined();
    expect(failureCode('Activity task failed')).toBeUndefined();
    expect(failureCode(null)).toBeUndefined();
  });
});

describe('failureMessage', () => {
  test('strips the code prefix so it is shown once', () => {
    expect(failureMessage('runner_unavailable: image is not available')).toBe(
      'image is not available',
    );
  });

  test('keeps an unprefixed wrapper readable', () => {
    expect(failureMessage('Activity task failed')).toBe('Activity task failed');
    expect(failureMessage(null)).toBe('run failed');
  });
});

describe('remediationFor', () => {
  test('known codes carry a hint', () => {
    expect(remediationFor('docker_unavailable')).toContain('docker compose exec worker docker version');
    expect(remediationFor('model_unresolved')).toContain('FACTORY_MODEL');
    expect(remediationFor('runner_unavailable')).toContain('factory-runner:local');
    expect(remediationFor('permission_timeout')).toContain('PERMISSION_TIMEOUT_MS');
  });

  test('unknown and missing codes fall back to the generic hint', () => {
    expect(remediationFor('ECONNRESET')).toContain('Temporal');
    expect(remediationFor(undefined)).toContain('Temporal');
  });
});

describe('temporalWorkflowUrl', () => {
  test('links to the workflow in the Temporal UI', () => {
    expect(temporalWorkflowUrl('run-run_abc')).toBe(
      'http://localhost:8233/namespaces/default/workflows/run-run_abc',
    );
    expect(temporalWorkflowUrl(null)).toBeNull();
  });
});
