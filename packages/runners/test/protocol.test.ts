import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HARNESS_COMMAND,
  DEFAULT_HARNESS_PORT,
  DEFAULT_READY_PATH,
  RunnerError,
  assertNoInferenceEnv,
  normalizeRunnerSpec,
  resolveSecrets,
  sanitizeHostEnv,
  sanitizeRunnerId,
  scrubSecrets,
} from '../src';

describe('runner spec', () => {
  test('fills harness defaults and a stable runnerId', () => {
    const spec = normalizeRunnerSpec({ runId: 'Run 42 / x' });
    expect(spec.runnerId).toBe('factory-run-42-x');
    expect(spec.harness.command).toBe(DEFAULT_HARNESS_COMMAND);
    expect(spec.harness.port).toBe(DEFAULT_HARNESS_PORT);
    expect(spec.harness.readyPath).toBe(DEFAULT_READY_PATH);
    expect(spec.readyTimeoutMs).toBe(60_000);
    expect(spec.secrets).toEqual([]);
  });

  test('keeps an explicit runnerId so lease is idempotent', () => {
    const a = normalizeRunnerSpec({ runId: 'r1', runnerId: 'Runner_One' });
    const b = normalizeRunnerSpec({ runId: 'r1', runnerId: 'Runner_One' });
    expect(a.runnerId).toBe('runner_one');
    expect(b.runnerId).toBe(a.runnerId);
  });

  test('rejects invalid specs', () => {
    expect(() => normalizeRunnerSpec({ runId: '' })).toThrow(RunnerError);
    expect(() => normalizeRunnerSpec({ runId: 'r', repo: { path: '/a', url: 'https://b' } })).toThrow(
      /exactly one of path or url/,
    );
    expect(() => normalizeRunnerSpec({ runId: 'r', harness: { port: -1 } })).toThrow(/invalid harness port/);
    expect(() => normalizeRunnerSpec({ runId: 'r', harness: { port: 70_000 } })).toThrow(
      /invalid harness port/,
    );
    expect(() => normalizeRunnerSpec({ runId: 'r', memoryMb: 10 })).toThrow(/invalid memory/);
    expect(() => sanitizeRunnerId('***')).toThrow(/no usable characters/);
  });
});

describe('secret boundary', () => {
  test('only allowlisted execution secrets can be injected', async () => {
    await expect(
      resolveSecrets([{ name: 'RANDOM_SECRET' }], { resolve: () => 'x' }),
    ).rejects.toMatchObject({ code: 'secret_not_granted' });

    await expect(
      resolveSecrets([{ name: 'GITHUB_TOKEN' }], { resolve: () => 'ghp_x' }),
    ).resolves.toEqual([{ name: 'GITHUB_TOKEN', value: 'ghp_x' }]);
  });

  test('inference credentials are rejected even if allowlisted', async () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'FACTORY_MODEL', 'GOOGLE_API_KEY']) {
      await expect(
        resolveSecrets([{ name }], {
          allowedSecrets: [name],
          resolve: () => 'sk-x',
        }),
      ).rejects.toMatchObject({ code: 'inference_credential_forbidden' });
    }
  });

  test('unresolvable secrets fail', async () => {
    await expect(
      resolveSecrets([{ name: 'GITHUB_TOKEN' }], { resolve: () => undefined }),
    ).rejects.toMatchObject({ code: 'secret_not_granted' });
  });

  test('env blocks cannot smuggle inference credentials', () => {
    expect(() => assertNoInferenceEnv({ GITHUB_TOKEN: 'x' })).not.toThrow();
    expect(() => assertNoInferenceEnv({ OPENAI_API_KEY: 'x' })).toThrow(
      /may not be injected into a runner/,
    );
  });

  test('host env is stripped of inference credentials', () => {
    const env = sanitizeHostEnv({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: 'sk',
      GITHUB_TOKEN: 'ghp',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({ GITHUB_TOKEN: 'ghp', PATH: '/usr/bin' });
  });

  test('scrubSecrets redacts every granted value', () => {
    expect(scrubSecrets('token=ghp_123 and ghp_123 again', ['ghp_123'])).toBe(
      'token=*** and *** again',
    );
  });
});
