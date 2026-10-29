import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerRunnerBackend, type ExecEvent } from '../src';

/**
 * Docker integration test. Opt-in: `RUN_SLOW=1 bun test`.
 * The first run builds `factory-runner:local` from `packages/runners/docker/Dockerfile`
 * (node 22 + git + opencode), which needs network and a few minutes.
 */
const slow = process.env.RUN_SLOW === '1';

const HARNESS = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(4096,'0.0.0.0')"`;

const backends: DockerRunnerBackend[] = [];
const workspaces: string[] = [];

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
    await instance.kill('slow-docker-1').catch(() => undefined);
  }
  for (const dir of workspaces.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!slow)('DockerRunnerBackend (slow)', () => {
  test(
    'lease → exec echo hi → artifacts → kill',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'factory-docker-test-'));
      workspaces.push(workspace);
      await writeFile(join(workspace, 'README.md'), '# Factory\n', 'utf8');

      const backend = new DockerRunnerBackend({ readyTimeoutMs: 180_000 });
      backends.push(backend);

      const handle = await backend.lease({
        runId: 'run-slow-docker',
        runnerId: 'slow-docker-1',
        workspace,
        harness: { command: HARNESS, port: 4096, readyPath: '/' },
        readyTimeoutMs: 180_000,
      });

      expect(handle.kind).toBe('docker');
      expect(handle.containerId).toBeTruthy();
      expect(handle.harnessUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.workspace).toBe(workspace);

      const echo = await collect(backend.exec(handle.runnerId, { command: 'echo hi' }));
      expect(echo).toEqual({ stdout: 'hi\n', stderr: '', code: 0, errors: [] });

      // Inference credentials must not leak into the sandbox.
      const env = await collect(backend.exec(handle.runnerId, { command: 'env' }));
      expect(env.code).toBe(0);
      expect(env.stdout).not.toContain('OPENAI_API_KEY');
      expect(env.stdout).not.toContain('ANTHROPIC_API_KEY');
      expect(env.stdout).not.toContain('FACTORY_MODEL');

      const heartbeat = await backend.heartbeat(handle.runnerId);
      expect(heartbeat.alive).toBe(true);

      const destDir = await mkdtemp(join(tmpdir(), 'factory-docker-artifacts-'));
      workspaces.push(destDir);
      const artifacts = await backend.artifacts(handle.runnerId, {
        destDir,
        paths: ['README.md'],
      });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ path: 'README.md', kind: 'file' });
      expect(artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);

      await backend.kill(handle.runnerId);
      expect((await backend.heartbeat(handle.runnerId)).alive).toBe(false);
      await backend.kill(handle.runnerId); // idempotent
      await expect(stat(workspace)).rejects.toThrow();
    },
    900_000,
  );
});
