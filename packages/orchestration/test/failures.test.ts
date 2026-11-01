import { describe, expect, test } from 'bun:test';
import { RunnerError } from '@factory/runners';
import { describeFailure } from '../src/failures';

/**
 * Cause-preserving failures (spec `run-lifecycle` › Cause-preserving failures).
 *
 * The defect: a run failed with `Activity task failed`, the Temporal wrapper, because the
 * workflow stored `error.message` of the `ActivityFailure` instead of walking its cause
 * chain. These tests pin the contract: the code and the real message survive, wrappers and
 * duplicates are dropped, and the deepest cause is what an operator reads.
 */

/** Shapes a Temporal failure the way the workflow sees it: `ActivityFailure` → `ApplicationFailure`. */
function temporalFailure(options: {
  message: string;
  code?: string;
  details?: unknown;
  outerMessage?: string;
}): unknown {
  const application = Object.assign(new Error(options.message), {
    name: 'ApplicationFailure',
    // Temporal's `type` carries the code when the activity set one (see `rethrowWithCause`).
    type: options.code ?? 'RunnerError',
    ...(options.details === undefined ? {} : { details: [options.details] }),
  });
  return Object.assign(new Error(options.outerMessage ?? 'Activity task failed'), {
    name: 'ActivityFailure',
    type: 'ActivityFailure',
    cause: application,
  });
}

describe('describeFailure', () => {
  test('plain Error keeps its message', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom');
  });

  test('RunnerError keeps its code', () => {
    expect(
      describeFailure(new RunnerError('docker_unavailable', 'docker CLI/server is not available')),
    ).toBe('docker_unavailable: docker CLI/server is not available');
  });

  test('nested cause includes the deepest message plus outer context', () => {
    const error = new Error('lease failed', {
      cause: new Error('docker CLI/server is not available'),
    });

    expect(describeFailure(error)).toBe(
      'docker CLI/server is not available (lease failed)',
    );
  });

  test('Temporal-shaped ActivityFailure yields code and message, not the wrapper', () => {
    const error = temporalFailure({
      message: 'docker CLI/server is not available',
      code: 'docker_unavailable',
      details: { code: 'docker_unavailable', message: 'docker CLI/server is not available' },
    });

    const text = describeFailure(error);
    expect(text).toBe('docker_unavailable: docker CLI/server is not available');
    expect(text).not.toContain('Activity task failed');
  });

  test('code is recovered from ApplicationFailure details when `type` is a class name', () => {
    const error = temporalFailure({
      message: 'image factory-runner:local is not available',
      details: { code: 'runner_unavailable', message: 'image factory-runner:local is not available' },
    });

    expect(describeFailure(error)).toBe(
      'runner_unavailable: image factory-runner:local is not available',
    );
  });

  test('duplicate messages are collapsed', () => {
    const error = new Error('boom', { cause: new Error('boom', { cause: new Error('boom') }) });

    expect(describeFailure(error)).toBe('boom');
  });

  test('a message contained in another is collapsed into the longer one', () => {
    const error = new Error('docker CLI/server is not available', {
      cause: new Error('docker CLI/server is not available'),
    });

    expect(describeFailure(error)).toBe('docker CLI/server is not available');
  });

  test('a chain of Temporal wrappers does not repeat the wrapper', () => {
    const error = temporalFailure({
      message: 'Activity task failed',
      outerMessage: 'Activity task failed',
    });

    expect(describeFailure(error)).toBe('Activity task failed');
  });

  test('a Node system error keeps its ALL-CAPS code exactly once', () => {
    const socket = Object.assign(
      new Error(
        'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true`',
      ),
      { code: 'ECONNRESET' },
    );
    const error = new TypeError('fetch failed', { cause: socket });

    const text = describeFailure(error);
    expect(text.startsWith('ECONNRESET: ')).toBe(true);
    expect(text.match(/ECONNRESET/g)?.length).toBe(1);
    expect(text).toContain('The socket connection was closed unexpectedly');
  });

  test('non-Error throwables and empty input stay readable', () => {
    expect(describeFailure('lease failed')).toBe('lease failed');
    expect(describeFailure(undefined)).toBe('run failed');
    expect(describeFailure({})).toBe('run failed');
  });

  test('a cause cycle terminates', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.assign(first, { cause: second });

    const text = describeFailure(first);
    expect(text).toContain('first');
    expect(text.length).toBeLessThan(200);
  });
});
