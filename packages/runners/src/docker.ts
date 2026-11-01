import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerError } from './errors';
import {
  normalizeRunnerSpec,
  sanitizeRunnerId,
  type Artifact,
  type ArtifactRequest,
  type ExecEvent,
  type ExecRequest,
  type RunnerBackend,
  type RunnerHandle,
  type RunnerHeartbeat,
  type RunnerSpec,
} from './protocol';
import { assertNoInferenceEnv, resolveSecrets, scrubSecrets, type ResolvedSecret } from './secrets';
import {
  hashArtifacts,
  prepareWorkspace,
  removeDir,
  runCommand,
  streamCommand,
  waitForReady,
} from './util';

const DOCKER_DIR = dirname(fileURLToPath(new URL('../docker/Dockerfile', import.meta.url)));
const DEFAULT_IMAGE = 'factory-runner:local';

export interface DockerRunnerOptions {
  dockerBin?: string;
  /** Defaults to `factory-runner:local`, built from `packages/runners/docker/Dockerfile`. */
  image?: string;
  allowedSecrets?: readonly string[];
  resolveSecret?: (name: string) => string | undefined | Promise<string | undefined>;
  /** Readiness timeout applied when the spec does not set one. */
  readyTimeoutMs?: number;
  /** Docker CLI timeout for control commands (inspect/port/rm). */
  controlTimeoutMs?: number;
  /** Build the default image on demand (defaults to true). */
  buildImage?: boolean;
  /**
   * Attach every sandbox to this user-defined docker network instead of publishing an
   * ephemeral host port. Required when the worker itself runs in a container: a port
   * published on the host's `127.0.0.1` is not reachable from another container's
   * loopback, so the harness would never answer its readiness probe.
   */
  network?: string;
  /**
   * How the workspace reaches the sandbox.
   *
   * `bind` (default) mounts the worker-local path into the container — correct when the
   * worker shares the docker daemon's filesystem, i.e. runs as a host process.
   * `copy` seeds the container with `docker cp` and copies the workspace back before
   * artifacts are collected — required when the worker runs in a container, where the
   * daemon cannot see the worker's filesystem.
   */
  workspaceMode?: 'bind' | 'copy';
}

interface Lease {
  handle: RunnerHandle;
  workspace: string;
  keepWorkspace: boolean;
  containerName: string;
  secrets: ResolvedSecret[];
}

interface ContainerState {
  id: string;
  running: boolean;
  startedAt?: string;
  labels: Record<string, string>;
}

/**
 * Docker backend: one container per run.
 *
 *   lease   → container with the workspace bind-mounted (or copied in), harness started
 *             inside, reachable either through a published 127.0.0.1 port (host worker) or
 *             through a user-defined network (containerised worker)
 *   exec    → `docker exec` streaming stdout/stderr/exit
 *   artifacts → `docker cp` into the run directory, hashed by sha256
 *   kill    → `docker rm -f`, idempotent, workspace removed unless kept
 *
 * Idempotency: the container name is derived from `runnerId`, so a retried `lease`
 * re-attaches to the same sandbox instead of creating a second one.
 */
export class DockerRunnerBackend implements RunnerBackend {
  readonly kind = 'docker' as const;

  private readonly dockerBin: string;
  private readonly image: string;
  private readonly allowedSecrets: readonly string[] | undefined;
  private readonly resolveSecret: DockerRunnerOptions['resolveSecret'];
  private readonly readyTimeoutMs: number;
  private readonly controlTimeoutMs: number;
  private readonly buildImage: boolean;
  private readonly network: string | undefined;
  private readonly workspaceMode: 'bind' | 'copy';
  private readonly leases = new Map<string, Lease>();
  private readonly builtImages = new Set<string>();

  constructor(options: DockerRunnerOptions = {}) {
    this.dockerBin = options.dockerBin ?? 'docker';
    this.image = options.image ?? DEFAULT_IMAGE;
    this.allowedSecrets = options.allowedSecrets;
    this.resolveSecret = options.resolveSecret;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
    this.controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
    this.buildImage = options.buildImage ?? true;
    this.network = options.network;
    this.workspaceMode = options.workspaceMode ?? 'bind';
  }

  async lease(input: RunnerSpec): Promise<RunnerHandle> {
    const spec = normalizeRunnerSpec(input);
    assertNoInferenceEnv(spec.env);
    assertNoInferenceEnv(spec.harness.env);

    if (spec.harness.port === 0) {
      throw new RunnerError(
        'invalid_spec',
        'docker backend requires an explicit harness port (0 means auto-assign and is local-only)',
        { runnerId: spec.runnerId },
      );
    }

    const secrets: ResolvedSecret[] = await resolveSecrets(spec.secrets, {
      allowedSecrets: this.allowedSecrets,
      resolve: this.resolveSecret,
    });

    await this.ensureDocker();

    const image = spec.image ?? this.image;
    await this.ensureImage(image);

    const containerName = containerNameFor(spec.runnerId);

    const existing = await this.inspect(containerName);
    if (existing?.running) {
      const workspace = existing.labels['factory.workspace'] ?? spec.workspace ?? '';
      // Re-attach without touching the workspace: a retried lease must not overwrite the
      // edits the harness has already made inside the container.
      const endpoint = await this.harnessEndpoint(containerName, spec.harness.port);
      const handle: RunnerHandle = {
        runnerId: spec.runnerId,
        kind: this.kind,
        workspace,
        harnessUrl: endpoint.url,
        containerId: existing.id,
        containerName,
        ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
      };
      this.leases.set(spec.runnerId, {
        handle,
        workspace,
        keepWorkspace: spec.keepWorkspace ?? false,
        containerName,
        secrets,
      });
      return handle;
    }

    if (existing) await this.removeContainer(containerName);

    const workspace = await prepareWorkspace(spec.repo, spec.workspace);

    const env: Record<string, string> = { ...spec.harness.env, ...spec.env };
    for (const secret of secrets) env[secret.name] = secret.value;

    const args = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      `factory.runner=${spec.runnerId}`,
      '--label',
      `factory.run=${spec.runId}`,
      '--label',
      `factory.workspace=${workspace}`,
      '-w',
      '/workspace',
    ];

    if (this.workspaceMode === 'bind') {
      args.push('-v', `${workspace}:/workspace`);
    }

    if (this.network) {
      // A user-defined network lets the worker reach the harness by container IP without
      // publishing a port on the host, which a containerised worker cannot reach.
      args.push('--network', this.network);
    } else {
      args.push('-p', `127.0.0.1::${spec.harness.port}`);
    }

    if (spec.cpu !== undefined) args.push('--cpus', String(spec.cpu));
    if (spec.memoryMb !== undefined) args.push('--memory', `${spec.memoryMb}m`);
    for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);

    args.push(image, 'sh', '-c', spec.harness.command);

    const run = await runCommand([this.dockerBin, ...args], { timeoutMs: this.controlTimeoutMs });
    if (run.code !== 0) {
      await removeDir(workspace).catch(() => undefined);
      throw new RunnerError('runner_unavailable', 'docker run failed', {
        runnerId: spec.runnerId,
        stderr: run.stderr.slice(-2000),
      });
    }

    const containerId = run.stdout.trim();

    if (this.workspaceMode === 'copy') {
      // The daemon cannot see the worker's filesystem when the worker runs in a container,
      // so the prepared workspace travels into the sandbox explicitly.
      const copied = await runCommand(
        [this.dockerBin, 'cp', `${workspace}/.`, `${containerName}:/workspace`],
        { timeoutMs: 10 * 60_000 },
      );
      if (copied.code !== 0) {
        await this.removeContainer(containerName).catch(() => undefined);
        await removeDir(workspace).catch(() => undefined);
        throw new RunnerError('runner_unavailable', 'docker cp of the workspace failed', {
          runnerId: spec.runnerId,
          containerId,
          stderr: copied.stderr.slice(-2000),
        });
      }
    }

    let endpoint: { url: string; port?: number };
    try {
      endpoint = await this.harnessEndpoint(containerName, spec.harness.port);
      await waitForReady({
        url: endpoint.url,
        readyPath: spec.harness.readyPath,
        timeoutMs: spec.readyTimeoutMs || this.readyTimeoutMs,
        ...(spec.harness.headers ? { headers: spec.harness.headers } : {}),
      });
    } catch (error) {
      const logs = await this.logs(containerName);
      await this.removeContainer(containerName).catch(() => undefined);
      await removeDir(workspace).catch(() => undefined);
      throw new RunnerError(
        'runner_unavailable',
        error instanceof Error ? error.message : String(error),
        { runnerId: spec.runnerId, containerId, logs },
      );
    }

    const handle: RunnerHandle = {
      runnerId: spec.runnerId,
      kind: this.kind,
      workspace,
      harnessUrl: endpoint.url,
      containerId,
      containerName,
      ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
    };

    this.leases.set(spec.runnerId, {
      handle,
      workspace,
      keepWorkspace: spec.keepWorkspace ?? false,
      containerName,
      secrets,
    });

    return handle;
  }

  async *exec(runnerId: string, req: ExecRequest): AsyncIterable<ExecEvent> {
    const lease = await this.leaseFor(runnerId);
    if (!lease) {
      yield { type: 'error', code: 'runner_not_found', message: `no sandbox for ${runnerId}` };
      return;
    }

    const env: Record<string, string> = {};
    for (const secret of lease.secrets) env[secret.name] = secret.value;
    Object.assign(env, req.env ?? {});

    const args = ['exec', '-i', '-w', req.cwd ?? '/workspace'];
    for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);
    args.push(lease.containerName);

    if (Array.isArray(req.command)) args.push(...req.command);
    else args.push('sh', '-c', req.command);

    for await (const event of streamCommand([this.dockerBin, ...args], {
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    })) {
      if (event.type === 'stdout' || event.type === 'stderr') {
        const data = scrubSecrets(
          event.data,
          lease.secrets.map((secret) => secret.value),
        );
        yield { type: event.type, data };
      } else {
        yield event;
      }
    }
  }

  async heartbeat(runnerId: string): Promise<RunnerHeartbeat> {
    const lease = await this.leaseFor(runnerId);
    if (!lease) return { runnerId, alive: false, kind: this.kind };

    const state = await this.inspect(lease.containerName);
    if (!state?.running) return { runnerId, alive: false, kind: this.kind };

    const heartbeat: RunnerHeartbeat = {
      runnerId,
      alive: true,
      kind: this.kind,
      uptimeMs: state.startedAt ? Math.max(0, Date.now() - Date.parse(state.startedAt)) : undefined,
    };

    const stats = await runCommand(
      [
        this.dockerBin,
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}}|{{.MemUsage}}',
        lease.containerName,
      ],
      { timeoutMs: 5_000 },
    ).catch(() => undefined);

    if (stats && stats.code === 0) {
      const [cpu, memory] = stats.stdout.trim().split('|');
      const percent = Number.parseFloat((cpu ?? '').replace('%', ''));
      if (Number.isFinite(percent)) heartbeat.cpuPercent = percent;
      if (memory) heartbeat.memory = memory.trim();
    }

    return heartbeat;
  }

  async artifacts(runnerId: string, req: ArtifactRequest): Promise<Artifact[]> {
    const lease = await this.leaseFor(runnerId);
    if (!lease) throw new RunnerError('runner_not_found', `no sandbox for ${runnerId}`);

    await mkdir(req.destDir, { recursive: true });

    if (this.workspaceMode === 'copy') {
      // Bring the sandbox's workspace back before diffing: the harness edited files inside
      // the container, and the worker's copy is the only place `git diff` can run.
      const copied = await runCommand(
        [this.dockerBin, 'cp', `${lease.containerName}:/workspace/.`, lease.workspace],
        { timeoutMs: 10 * 60_000 },
      );
      if (copied.code !== 0) {
        throw new RunnerError('artifact_not_found', 'cannot copy the workspace back', {
          runnerId,
          stderr: copied.stderr.slice(-2000),
        });
      }
    }

    if (req.includeGitDiff) {
      const diff = await runCommand(['git', '-C', lease.workspace, 'diff', '--binary']);
      if (diff.code === 0 && diff.stdout.length > 0) {
        await writeFile(join(req.destDir, 'patch.diff'), diff.stdout, 'utf8');
      }
    }

    for (const path of req.paths ?? []) {
      const result = await runCommand(
        [this.dockerBin, 'cp', `${lease.containerName}:/workspace/${path}`, req.destDir],
        { timeoutMs: this.controlTimeoutMs },
      );
      if (result.code !== 0) {
        throw new RunnerError('artifact_not_found', `cannot collect ${path}`, {
          path,
          stderr: result.stderr.slice(-2000),
        });
      }
    }

    return hashArtifacts(req.destDir);
  }

  async kill(runnerId: string): Promise<void> {
    const lease = this.leases.get(runnerId);
    const containerName = lease?.containerName ?? containerNameFor(sanitizeRunnerId(runnerId));
    // Read the workspace before removing the container: the label disappears with it.
    const workspace = lease?.workspace ?? (await this.workspaceFromLabel(containerName));

    await this.removeContainer(containerName);

    if (workspace && !(lease?.keepWorkspace ?? false)) {
      await removeDir(workspace).catch(() => undefined);
    }

    this.leases.delete(runnerId);
  }

  /* ---------------------------------------------------------------------- */

  private async leaseFor(runnerId: string): Promise<Lease | undefined> {
    const lease = this.leases.get(runnerId);
    if (lease) return lease;

    const containerName = containerNameFor(sanitizeRunnerId(runnerId));
    const state = await this.inspect(containerName);
    if (!state?.running) return undefined;

    const workspace = state.labels['factory.workspace'] ?? '';
    const leaseFromDocker: Lease = {
      handle: {
        runnerId,
        kind: this.kind,
        workspace,
        harnessUrl: '',
        containerId: state.id,
        containerName,
      },
      workspace,
      keepWorkspace: false,
      containerName,
      secrets: [],
    };
    this.leases.set(runnerId, leaseFromDocker);
    return leaseFromDocker;
  }

  private async ensureDocker(): Promise<void> {
    const result = await runCommand([this.dockerBin, 'version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000,
    }).catch(() => undefined);

    if (!result || result.code !== 0) {
      throw new RunnerError('docker_unavailable', 'docker CLI/server is not available', {
        stderr: result?.stderr.slice(-500),
      });
    }
  }

  private async ensureImage(image: string): Promise<void> {
    if (this.builtImages.has(image)) return;

    const inspect = await runCommand([this.dockerBin, 'image', 'inspect', image], {
      timeoutMs: this.controlTimeoutMs,
    });
    if (inspect.code === 0) {
      this.builtImages.add(image);
      return;
    }

    if (!this.buildImage || image !== this.image) {
      throw new RunnerError('runner_unavailable', `image ${image} is not available`, { image });
    }

    const dockerfile = join(DOCKER_DIR, 'Dockerfile');
    if (!existsSync(dockerfile)) {
      throw new RunnerError('runner_unavailable', `Dockerfile missing at ${dockerfile}`);
    }

    const build = await runCommand(
      [this.dockerBin, 'build', '-t', image, '-f', dockerfile, DOCKER_DIR],
      { timeoutMs: 15 * 60_000 },
    );
    if (build.code !== 0) {
      throw new RunnerError('runner_unavailable', `docker build failed for ${image}`, {
        image,
        stderr: build.stderr.slice(-3000),
      });
    }

    this.builtImages.add(image);
  }

  private async inspect(containerName: string): Promise<ContainerState | undefined> {
    const result = await runCommand([this.dockerBin, 'inspect', containerName], {
      timeoutMs: this.controlTimeoutMs,
    });
    if (result.code !== 0) return undefined;

    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        Id?: string;
        State?: { Running?: boolean; StartedAt?: string };
        Config?: { Labels?: Record<string, string> | null };
      }>;
      const info = parsed[0];
      if (!info?.Id) return undefined;
      return {
        id: info.Id,
        running: info.State?.Running === true,
        startedAt: info.State?.StartedAt,
        labels: info.Config?.Labels ?? {},
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Where the worker reaches the harness: a published host port (host worker) or the
   * container's IP on the configured user-defined network (containerised worker).
   */
  private async harnessEndpoint(
    containerName: string,
    containerPort: number,
  ): Promise<{ url: string; port?: number }> {
    if (this.network) {
      const address = await this.networkAddress(containerName, this.network);
      return { url: `http://${address}:${containerPort}` };
    }
    const port = await this.mappedPort(containerName, containerPort);
    return { url: `http://127.0.0.1:${port}`, port };
  }

  /** Container IP on `network`, read from `docker inspect` (no DNS-name guessing). */
  private async networkAddress(containerName: string, network: string): Promise<string> {
    const result = await runCommand(
      [
        this.dockerBin,
        'inspect',
        '--format',
        `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
        containerName,
      ],
      { timeoutMs: this.controlTimeoutMs },
    );
    const address = result.stdout.trim();
    if (result.code !== 0 || address.length === 0) {
      throw new RunnerError(
        'runner_unavailable',
        `cannot read the address of ${containerName} on network ${network}`,
        { containerName, network, stderr: result.stderr.slice(-1000) },
      );
    }
    return address;
  }

  private async mappedPort(containerName: string, containerPort: number): Promise<number> {
    const result = await runCommand(
      [this.dockerBin, 'port', containerName, `${containerPort}/tcp`],
      { timeoutMs: this.controlTimeoutMs },
    );
    if (result.code !== 0) {
      throw new RunnerError('runner_unavailable', `cannot resolve port ${containerPort}`, {
        containerName,
        stderr: result.stderr.slice(-1000),
      });
    }

    const line = result.stdout.trim().split('\n').at(-1) ?? '';
    const port = Number.parseInt(line.slice(line.lastIndexOf(':') + 1), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new RunnerError('runner_unavailable', `unexpected docker port output "${line}"`, {
        containerName,
      });
    }
    return port;
  }

  private async logs(containerName: string): Promise<string> {
    const result = await runCommand([this.dockerBin, 'logs', '--tail', '80', containerName], {
      timeoutMs: 10_000,
    }).catch(() => undefined);
    return `${result?.stdout ?? ''}${result?.stderr ?? ''}`.slice(-4000);
  }

  private async workspaceFromLabel(containerName: string): Promise<string | undefined> {
    const state = await this.inspect(containerName);
    return state?.labels['factory.workspace'];
  }

  private async removeContainer(containerName: string): Promise<void> {
    const result = await runCommand([this.dockerBin, 'rm', '-f', containerName], {
      timeoutMs: this.controlTimeoutMs,
    });
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
      throw new RunnerError('runner_unavailable', `cannot remove ${containerName}`, {
        containerName,
        stderr: result.stderr.slice(-1000),
      });
    }
  }
}

export function containerNameFor(runnerId: string): string {
  return `factory-runner-${runnerId}`;
}
