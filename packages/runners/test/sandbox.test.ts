import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LocalRunnerBackend,
  bwrapCommand,
  buildSandboxProfile,
  sandboxAvailability,
  sandboxModeFromEnv,
  type ExecEvent,
} from '../src';

/**
 * Local sandbox (harden-runtime, task 6.3, ADR-025).
 *
 * The profile generator is platform-independent and tested everywhere. The confinement
 * assertions run only on macOS (sandbox-exec is macOS-only) and are skipped elsewhere.
 */

const macos = process.platform === 'darwin';
const HARNESS = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1')"`;

const backends: LocalRunnerBackend[] = [];
const roots: string[] = [];

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'factory-sandbox-test-'));
  roots.push(dir);
  return dir;
}

function backend(options: ConstructorParameters<typeof LocalRunnerBackend>[0] = {}) {
  const instance = new LocalRunnerBackend({ readyTimeoutMs: 20_000, ...options });
  backends.push(instance);
  return instance;
}

async function collect(stream: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  let stdout = '';
  let stderr = '';
  let code = -1;
  for await (const event of stream) {
    if (event.type === 'stdout') stdout += event.data;
    else if (event.type === 'stderr') stderr += event.data;
    else if (event.type === 'exit') code = event.code;
  }
  return { stdout, stderr, code };
}

afterEach(async () => {
  for (const instance of backends.splice(0)) {
    await instance.kill('runner_sandbox').catch(() => undefined);
  }
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('sandbox profile', () => {
  test('denies by default and confines writes to workspace, run dir and /private/tmp', () => {
    const profile = buildSandboxProfile({
      workspace: '/tmp/run/workspace',
      runDir: '/tmp/run',
      network: 'denied',
    });
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(subpath "/tmp/run/workspace")');
    expect(profile).toContain('(subpath "/tmp/run")');
    expect(profile).toContain('(subpath "/private/tmp")');
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).not.toContain('(allow network-outbound)');
    expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
  });

  test('grants outbound network when the stage allows it', () => {
    const profile = buildSandboxProfile({
      workspace: '/tmp/run/workspace',
      runDir: '/tmp/run',
      network: 'allowed',
    });
    expect(profile).toContain('(allow network-outbound)');
    expect(profile).not.toContain('(deny network-outbound)');
  });

  test('reports the sandbox backend as unavailable off macOS', () => {
    const availability = sandboxAvailability('exec', 'linux');
    expect(availability.active).toBe(false);
    expect(availability.unavailable).toBe(true);
    expect(availability.reason).toContain('unsupported_platform');
  });

  test('a simulated non-macOS lease falls back without confinement', async () => {
    const runDir = await root();
    const workspace = join(runDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'README.md'), '# ok\n', 'utf8');

    const instance = backend({ sandbox: 'exec', platform: 'linux' });
    const handle = await instance.lease({
      runId: 'runner_sandbox',
      runnerId: 'runner_sandbox',
      workspace,
      runDir,
      harness: { command: HARNESS, port: 0, readyPath: '/' },
    });
    expect(handle.sandbox?.mode).toBe('exec');
    expect(handle.sandbox?.active).toBe(false);
    expect(handle.sandbox?.reason).toContain('unsupported_platform');
    const result = await collect(instance.exec('runner_sandbox', { command: 'echo fallback' }));
    expect(result.stdout.trim()).toBe('fallback');
  }, 30_000);
});

describe('bwrap jail', () => {
  test('builds the minimal jail argv', () => {
    const argv = bwrapCommand(
      { workspace: '/work/run/workspace', network: 'allowed', binary: '/usr/bin/bwrap' },
      '/bin/sh',
      'echo hi',
    );
    expect(argv).toEqual([
      '/usr/bin/bwrap',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      '--bind',
      '/work/run/workspace',
      '/work/run/workspace',
      '--chdir',
      '/work/run/workspace',
      '--',
      '/bin/sh',
      '-c',
      'echo hi',
    ]);
  });

  test('unshares the network namespace only when the policy denies network', () => {
    const denied = bwrapCommand(
      { workspace: '/work/run/workspace', network: 'denied', binary: '/usr/bin/bwrap' },
      '/bin/sh',
      'ls',
    );
    expect(denied).toContain('--unshare-net');
    expect(denied[denied.length - 4]).toBe('--');

    const allowed = bwrapCommand(
      { workspace: '/work/run/workspace', network: 'allowed', binary: '/usr/bin/bwrap' },
      '/bin/sh',
      'ls',
    );
    expect(allowed).not.toContain('--unshare-net');
  });

  test('honours an explicit working directory inside the jail', () => {
    const argv = bwrapCommand(
      {
        workspace: '/work/run/workspace',
        network: 'denied',
        cwd: '/work/run/workspace/src',
        binary: '/usr/bin/bwrap',
      },
      '/bin/sh',
      'pwd',
    );
    expect(argv).toContain('--chdir');
    expect(argv[argv.indexOf('--chdir') + 1]).toBe('/work/run/workspace/src');
    expect(argv[argv.length - 1]).toBe('pwd');
  });

  test('reports bwrap as unavailable off Linux', () => {
    const availability = sandboxAvailability('bwrap', 'darwin');
    expect(availability.active).toBe(false);
    expect(availability.unavailable).toBe(true);
    expect(availability.reason).toContain('unsupported_platform');
  });

  test('a missing bwrap binary is unavailable, never a silent fallback', () => {
    const availability = sandboxAvailability('bwrap', 'linux', { which: () => null });
    expect(availability.active).toBe(false);
    expect(availability.unavailable).toBe(true);
    expect(availability.reason).toContain('bwrap_missing');
    expect(availability.binary).toBeNull();
  });

  test('an installed bwrap is active and resolves its path', () => {
    const availability = sandboxAvailability('bwrap', 'linux', {
      which: (name) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
    });
    expect(availability).toEqual({
      mode: 'bwrap',
      active: true,
      reason: null,
      unavailable: false,
      binary: '/usr/bin/bwrap',
    });
  });
});

describe('sandbox mode selection', () => {
  test('Linux auto-selects bwrap when the binary is installed', () => {
    expect(sandboxModeFromEnv(undefined, 'linux', { which: () => '/usr/bin/bwrap' })).toBe('bwrap');
  });

  test('falls back to none when bwrap is absent or the platform is macOS', () => {
    expect(sandboxModeFromEnv(undefined, 'linux', { which: () => null })).toBe('none');
    expect(sandboxModeFromEnv(undefined, 'darwin', { which: () => '/usr/bin/bwrap' })).toBe('none');
  });

  test('honours an explicit RUNNER_SANDBOX value', () => {
    expect(sandboxModeFromEnv('bwrap', 'darwin')).toBe('bwrap');
    expect(sandboxModeFromEnv('exec', 'linux')).toBe('exec');
    expect(sandboxModeFromEnv('none', 'linux')).toBe('none');
    expect(sandboxModeFromEnv('1', 'linux')).toBe('none');
  });
});

describe.skipIf(!macos)('sandbox-exec confinement (macOS)', () => {
  async function sandboxed(network: 'allowed' | 'denied') {
    const runDir = await root();
    const workspace = join(runDir, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'README.md'), '# ok\n', 'utf8');
    const instance = backend({ sandbox: 'exec' });
    const handle = await instance.lease({
      runId: 'runner_sandbox',
      runnerId: 'runner_sandbox',
      workspace,
      runDir,
      harness: { command: HARNESS, port: 0, readyPath: '/' },
      networkPolicy: network,
    });
    expect(handle.sandbox?.active).toBe(true);
    return { instance, runDir, workspace };
  }

  test('allows a write inside the workspace', async () => {
    const { instance, workspace } = await sandboxed('denied');
    const result = await collect(
      instance.exec('runner_sandbox', { command: `echo inside > ${join(workspace, 'inside.txt')}` }),
    );
    expect(result.code).toBe(0);
    expect((await readFile(join(workspace, 'inside.txt'), 'utf8')).trim()).toBe('inside');
  }, 30_000);

  test('blocks a write outside the workspace at the OS level', async () => {
    const { instance, runDir } = await sandboxed('denied');
    const outside = join(dirname(runDir), 'outside.txt');
    const result = await collect(
      instance.exec('runner_sandbox', { command: `echo nope > ${outside}` }),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Operation not permitted');
    await expect(readFile(outside, 'utf8')).rejects.toThrow();
  }, 30_000);

  test('denies network unless the stage grants it', async () => {
    const denied = await sandboxed('denied');
    const deniedResult = await collect(
      denied.instance.exec('runner_sandbox', {
        command: `node -e "require('net').connect(1,'127.0.0.1').on('error',(e)=>{console.log(e.code);process.exit(e.code==='EPERM'?0:1)})"`,
      }),
    );
    expect(deniedResult.code).toBe(0);
    expect(deniedResult.stdout).toContain('EPERM');

    const allowed = await sandboxed('allowed');
    const allowedResult = await collect(
      allowed.instance.exec('runner_sandbox', {
        command: `node -e "require('net').connect(1,'127.0.0.1').on('error',(e)=>{console.log(e.code);process.exit(e.code==='ECONNREFUSED'?0:1)})"`,
      }),
    );
    expect(allowedResult.code).toBe(0);
    expect(allowedResult.stdout).toContain('ECONNREFUSED');
  }, 30_000);
});
