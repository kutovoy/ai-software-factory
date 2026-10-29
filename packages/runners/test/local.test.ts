import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRunnerBackend, runCommand, type ExecEvent, type RunnerHandle } from '../src';

const HARNESS = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'0.0.0.0')"`;

const backends: LocalRunnerBackend[] = [];
const workspaces: string[] = [];

function backend(options: ConstructorParameters<typeof LocalRunnerBackend>[0] = {}) {
  const instance = new LocalRunnerBackend({ readyTimeoutMs: 10_000, ...options });
  backends.push(instance);
  return instance;
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-runner-test-'));
  workspaces.push(dir);
  return dir;
}

async function collect(stream: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  errors: string[];
}> {
  let stdout = '';
  let stderr = '';
  let code = -1;
  const errors: string[] = [];
  for await (const event of stream) {
    if (event.type === 'stdout') stdout += event.data;
    else if (event.type === 'stderr') stderr += event.data;
    else if (event.type === 'exit') code = event.code;
    else errors.push(event.code);
  }
  return { stdout, stderr, code, errors };
}

afterEach(async () => {
  for (const instance of backends.splice(0)) {
    for (const runnerId of ['runner_local', 'runner_timeout', 'runner_secret']) {
      await instance.kill(runnerId).catch(() => undefined);
    }
  }
  for (const dir of workspaces.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('LocalRunnerBackend', () => {
  test('lease → exec → artifacts → kill', async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, 'README.md'), '# Factory\n', 'utf8');
    await runCommand(['git', 'init', '-q'], { cwd: workspace });
    await runCommand(['git', 'add', '.'], { cwd: workspace });
    await runCommand(
      ['git', '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init'],
      { cwd: workspace },
    );

    const runner = backend();
    const handle: RunnerHandle = await runner.lease({
      runId: 'run-local-1',
      runnerId: 'runner_local',
      workspace,
      harness: { command: HARNESS, readyPath: '/', port: 0 },
    });

    expect(handle.kind).toBe('local');
    expect(handle.workspace).toBe(workspace);
    expect(handle.harnessUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.pid).toBeGreaterThan(0);

    const echo = await collect(runner.exec(handle.runnerId, { command: 'echo hi' }));
    expect(echo).toEqual({ stdout: 'hi\n', stderr: '', code: 0, errors: [] });

    const heartbeat = await runner.heartbeat(handle.runnerId);
    expect(heartbeat.alive).toBe(true);
    expect(heartbeat.uptimeMs).toBeGreaterThanOrEqual(0);

    await collect(runner.exec(handle.runnerId, { command: 'printf "changed\n" >> README.md' }));

    const destDir = await tempWorkspace();
    const artifacts = await runner.artifacts(handle.runnerId, {
      destDir,
      paths: ['README.md'],
      includeGitDiff: true,
    });

    const patch = artifacts.find((artifact) => artifact.path === 'patch.diff');
    expect(patch?.kind).toBe('patch');
    expect(patch?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(destDir, 'patch.diff'), 'utf8')).toContain('+changed');

    const readme = artifacts.find((artifact) => artifact.path === 'README.md');
    expect(readme?.bytes).toBeGreaterThan(0);
    expect((await stat(join(destDir, 'README.md'))).isFile()).toBe(true);

    await runner.kill(handle.runnerId);
    expect((await runner.heartbeat(handle.runnerId)).alive).toBe(false);
    // kill is idempotent
    await runner.kill(handle.runnerId);
    // workspace is removed unless keepWorkspace is set
    await expect(stat(workspace)).rejects.toThrow();
  });

  test('lease is idempotent for the same runnerId', async () => {
    const runner = backend();
    const spec = {
      runId: 'run-local-2',
      runnerId: 'runner_local',
      harness: { command: HARNESS, readyPath: '/', port: 0 },
    };
    const first = await runner.lease(spec);
    const second = await runner.lease(spec);
    expect(second.pid).toBe(first.pid);
    expect(second.harnessUrl).toBe(first.harnessUrl);
  });

  test('exec streams stdout and honours the timeout', async () => {
    const runner = backend();
    const handle = await runner.lease({
      runId: 'run-local-3',
      runnerId: 'runner_timeout',
      harness: { command: HARNESS, readyPath: '/', port: 0 },
    });

    const slow = await collect(
      runner.exec(handle.runnerId, { command: 'sleep 5', timeoutMs: 200 }),
    );
    expect(slow.code).toBe(124);

    const missing = await collect(runner.exec('nope', { command: 'echo hi' }));
    expect(missing.errors).toEqual(['runner_not_found']);
  });

  test('granted secrets are injected and scrubbed from output', async () => {
    const runner = backend({
      resolveSecret: (name) => (name === 'GITHUB_TOKEN' ? 'ghp_super_secret' : undefined),
    });
    const handle = await runner.lease({
      runId: 'run-local-4',
      runnerId: 'runner_secret',
      harness: { command: HARNESS, readyPath: '/', port: 0 },
      secrets: [{ name: 'GITHUB_TOKEN' }],
    });

    const result = await collect(
      runner.exec(handle.runnerId, { command: 'printf "%s" "$GITHUB_TOKEN"' }),
    );
    expect(result.stdout).toBe('***');
    expect(result.stdout).not.toContain('ghp_super_secret');

    await expect(
      runner.lease({
        runId: 'run-local-5',
        runnerId: 'runner_secret_2',
        harness: { command: HARNESS, readyPath: '/', port: 0 },
        secrets: [{ name: 'OPENAI_API_KEY' }],
      }),
    ).rejects.toMatchObject({ code: 'inference_credential_forbidden' });
  });

  test('a harness that never becomes ready fails with runner_unavailable', async () => {
    const runner = backend();
    await expect(
      runner.lease({
        runId: 'run-local-6',
        runnerId: 'runner_bad',
        harness: { command: 'node -e "process.exit(1)"', readyPath: '/', port: 0 },
        readyTimeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: 'runner_unavailable' });
  });
});
