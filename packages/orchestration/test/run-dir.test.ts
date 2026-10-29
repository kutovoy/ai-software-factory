import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { artifactsDir, eventsPath, patchPath, runDir, sanitizeRunId } from '../src/run-dir';

describe('run directory layout', () => {
  test('paths match runs/<runId>/{events.jsonl,patch.diff,artifacts/}', () => {
    const root = '/tmp/runs';
    expect(runDir(root, 'run_abc')).toBe(join(root, 'run_abc'));
    expect(eventsPath(root, 'run_abc')).toBe(join(root, 'run_abc', 'events.jsonl'));
    expect(patchPath(root, 'run_abc')).toBe(join(root, 'run_abc', 'patch.diff'));
    expect(artifactsDir(root, 'run_abc')).toBe(join(root, 'run_abc', 'artifacts'));
  });

  test('run ids cannot escape the runs directory', () => {
    expect(sanitizeRunId('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeRunId('run_1')).toBe('run_1');
    expect(() => sanitizeRunId('../..')).toThrow();
  });
});
