import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Artifact, ExecEvent, RepoSpec } from './protocol';
import { RunnerError } from './errors';

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns a process and streams stdout/stderr as `ExecEvent`s, ending with exactly one
 * `exit`. A timeout or abort kills the process and reports `124` / `130`.
 */
export async function* streamCommand(
  command: string[],
  options: CommandOptions = {},
): AsyncGenerator<ExecEvent> {
  if (command.length === 0) {
    yield { type: 'error', code: 'exec_failed', message: 'empty command' };
    return;
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    yield { type: 'error', code: 'exec_failed', message: errorMessage(error) };
    return;
  }

  const queue: ExecEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  let timedOut = false;
  let aborted = false;

  const push = (event: ExecEvent): void => {
    queue.push(event);
    if (wake) {
      const resolve = wake;
      wake = undefined;
      resolve();
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => push({ type: 'stdout', data: chunk.toString('utf8') }));
  child.stderr?.on('data', (chunk: Buffer) => push({ type: 'stderr', data: chunk.toString('utf8') }));
  child.on('error', (error) => push({ type: 'error', code: 'exec_failed', message: errorMessage(error) }));
  child.on('close', (code, signal) => {
    const exitCode = timedOut ? 124 : aborted ? 130 : (code ?? (signal ? 137 : 1));
    push({ type: 'exit', code: exitCode });
    closed = true;
    if (wake) {
      const resolve = wake;
      wake = undefined;
      resolve();
    }
  });

  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : undefined;

  const onAbort = (): void => {
    aborted = true;
    child.kill('SIGKILL');
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (queue.length > 0 || closed) {
          wake = undefined;
          resolve();
        }
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function runCommand(
  command: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  let code = 0;

  for await (const event of streamCommand(command, options)) {
    if (event.type === 'stdout') stdout += event.data;
    else if (event.type === 'stderr') stderr += event.data;
    else if (event.type === 'exit') code = event.code;
    else if (event.type === 'error') throw new RunnerError('exec_failed', event.message, { command });
  }

  return { code, stdout, stderr };
}

export async function runOrThrow(
  command: string[],
  options: CommandOptions & { errorCode?: 'exec_failed' | 'runner_unavailable' } = {},
): Promise<CommandResult> {
  const result = await runCommand(command, options);
  if (result.code !== 0) {
    throw new RunnerError(options.errorCode ?? 'exec_failed', `command failed (${result.code})`, {
      command,
      stdout: result.stdout.slice(-2000),
      stderr: result.stderr.slice(-2000),
    });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReadyTarget {
  url: string;
  /** HTTP path to poll. Empty string means "TCP connect only". */
  readyPath: string;
  timeoutMs: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Waits until the harness answers. Backs off exponentially; on timeout the caller is
 * expected to tear the sandbox down and surface `runner_unavailable`.
 */
export async function waitForReady(target: ReadyTarget): Promise<void> {
  const deadline = Date.now() + target.timeoutMs;
  let delay = target.initialDelayMs ?? 100;
  const maxDelay = target.maxDelayMs ?? 1_000;
  let lastError = 'no response';

  const parsed = new URL(target.url);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));

  while (Date.now() < deadline) {
    try {
      if (target.readyPath === '') {
        await tcpProbe(host, port);
        return;
      }
      const response = await fetch(`${target.url}${target.readyPath}`, {
        signal: AbortSignal.timeout(Math.max(1_000, Math.min(5_000, deadline - Date.now()))),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }

  throw new RunnerError(
    'runner_unavailable',
    `harness at ${target.url} was not ready within ${target.timeoutMs}ms`,
    { url: target.url, readyPath: target.readyPath, lastError },
  );
}

async function tcpProbe(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('TCP connect timeout'));
    }, 1_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Creates the workspace and checks out the pinned commit.
 * `repo.path` clones locally (dev + tests); `repo.url` clones remotely.
 */
export async function prepareWorkspace(repo?: RepoSpec, workspace?: string): Promise<string> {
  const dir = workspace ?? (await mkdtemp(join(tmpdir(), 'factory-run-')));
  await mkdir(dir, { recursive: true });

  if (!repo) return dir;

  if (repo.path) {
    if (!existsSync(repo.path)) {
      throw new RunnerError('invalid_spec', `repo.path does not exist: ${repo.path}`, {
        path: repo.path,
      });
    }
    const commit =
      repo.commit ?? (await runOrThrow(['git', '-C', repo.path, 'rev-parse', 'HEAD'])).stdout.trim();

    if (await isEmptyDir(dir)) {
      await runOrThrow(['git', 'clone', '--no-checkout', repo.path, dir], {
        errorCode: 'runner_unavailable',
      });
    }
    await runOrThrow(['git', '-C', dir, 'checkout', '--detach', commit], {
      errorCode: 'runner_unavailable',
    });
    return dir;
  }

  if (repo.url) {
    if (await isEmptyDir(dir)) {
      await runOrThrow(['git', 'clone', repo.url, dir], { errorCode: 'runner_unavailable' });
    }
    if (repo.commit) {
      await runOrThrow(['git', '-C', dir, 'checkout', '--detach', repo.commit], {
        errorCode: 'runner_unavailable',
      });
    }
    return dir;
  }

  return dir;
}

async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.length === 0;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return existsSync(join(dir, '.git'));
}

export async function gitDiff(dir: string): Promise<string | undefined> {
  if (!(await isGitRepo(dir))) return undefined;
  const result = await runCommand(['git', '-C', dir, 'diff', '--binary']);
  return result.code === 0 ? result.stdout : undefined;
}

/** Copies workspace-relative paths into `destDir` (local backend). */
export async function copyFromWorkspace(
  workspace: string,
  paths: readonly string[],
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  for (const relative of paths) {
    const source = join(workspace, relative);
    const target = join(destDir, basename(relative));
    try {
      await cp(source, target, { recursive: true });
    } catch (error) {
      throw new RunnerError('artifact_not_found', `cannot collect ${relative}`, {
        path: relative,
        cause: errorMessage(error),
      });
    }
  }
}

/** Writes `patch.diff` when the workspace is a git checkout. */
export async function writePatch(workspace: string, destDir: string): Promise<boolean> {
  const diff = await gitDiff(workspace);
  if (diff === undefined) return false;
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, 'patch.diff'), diff, 'utf8');
  return true;
}

/** Hashes everything under `destDir` into artifact references (path + sha256, never blobs). */
export async function hashArtifacts(destDir: string): Promise<Artifact[]> {
  const files = await walkFiles(destDir);
  const artifacts: Artifact[] = [];
  for (const file of files) {
    const bytes = await stat(file);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    artifacts.push({
      path: relativeTo(destDir, file),
      bytes: bytes.size,
      sha256: hash,
      kind: artifactKind(file),
    });
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

export async function walkFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(full)));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function relativeTo(root: string, file: string): string {
  return file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]+/, '') : file;
}

function artifactKind(file: string): Artifact['kind'] {
  const lower = file.toLowerCase();
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return 'patch';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'log';
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return 'screenshot';
  return 'file';
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
