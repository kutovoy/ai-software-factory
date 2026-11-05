import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ApplicationFailure, heartbeat as activityHeartbeat } from '@temporalio/activity';
import { FakeAdapter, type SessionHandle, type UsageReport } from '@factory/adapters';
import {
  appendWorkItemEvent,
  collectSecretReferences,
  envSecretResolver,
  loadDefinition,
  recordRunSecrets,
  type AgentDef,
} from '@factory/core';
import {
  DEFAULT_HARNESS_COMMAND,
  DockerRunnerBackend,
  LocalRunnerBackend,
  RunnerError,
  isRunnerError,
  type Artifact,
  type RunnerBackend,
  type RunnerHandle,
} from '@factory/runners';
import { loadConfig } from '../config';
import { RemoteRunnerBackend, isRemoteRun } from '../remote-runner';
import { harnessPasswordFor, harnessProbeHeaders } from '../harness-auth';
import { heartbeat } from '../heartbeat';
import { getSql, upsertStep } from '../db';
import { artifactsDir, ensureRunDir, patchPath, runDir } from '../run-dir';
import { createAdapter, dropSession, getSession } from '../sessions';
import type { LeaseInfo, RunArtifact, RunInput } from '../types';

/**
 * Runner activities: lease → (harness runs inside) → artifacts → kill.
 *
 * The fake harness needs no sandbox (the scripted adapter runs in-process), so it gets an
 * *ephemeral* lease: a workspace directory only, no container, no network. Every other
 * harness goes through `@factory/runners` (`docker` or `local`), which is where all tool
 * execution happens (ADR-009).
 *
 * Idempotency is the runner protocol's job: `runnerId` defaults to `factory-<runId>`, so a
 * retried lease re-attaches instead of starting a second sandbox, and `kill` is a no-op
 * when nothing is leased.
 */

const ephemeralLeases = new Map<string, LeaseInfo>();

/**
 * Preserves a runner error code through Temporal's failure serialization.
 *
 * A plain `RunnerError` thrown from an activity becomes an `ApplicationFailure` with
 * `type: 'RunnerError'` and no code, so the workflow (and the run row) can no longer tell
 * `docker_unavailable` from `runner_unavailable`. Throwing an explicit `ApplicationFailure`
 * with `type = error.code` and the error shape in `details` keeps the code in the chain that
 * `describeFailure()` walks. Retry behaviour is unchanged (`nonRetryable: false`).
 */
function rethrowWithCause(error: unknown): never {
  if (isRunnerError(error)) {
    throw ApplicationFailure.create({
      type: error.code,
      message: error.message,
      details: [error.toJSON()],
      nonRetryable: false,
    });
  }
  throw error;
}


/**
 * `@factory/runners` bans every `OPENAI_*` name from `spec.env` and `spec.harness.env`
 * (that is the provider-credential boundary). The inference proxy therefore reaches the
 * harness through the harness *command*: a per-run token and the proxy base URL, never the
 * provider key. The token is revoked when the run ends (ADR-011).
 *
 * `OPENCODE_SERVER_PASSWORD` travels the same way: opencode `serve` generates a random
 * password otherwise and then rejects the adapter's readiness probe with
 * `401 Authentication required` (see `harness-auth.ts`).
 */
export function harnessCommandWithProxyEnv(
  env: Record<string, string> | undefined,
  runId: string,
): string {
  const entries = [
    ...Object.entries(env ?? {}).filter(([, value]) => value !== ''),
    ['OPENCODE_SERVER_PASSWORD', harnessPasswordFor(runId)] as [string, string],
  ];
  const prefix = entries
    .map(([name, value]) => `${name}='${value.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  return `${prefix} ${DEFAULT_HARNESS_COMMAND}`;
}

function isEphemeralRun(input: RunInput): boolean {
  return (
    input.harness === 'fake' ||
    input.runner === 'fake' ||
    // A replay is an in-process adapter: it re-emits a recording and applies its patch,
    // so it needs a workspace but no sandbox process (spec `benchmark-replay`).
    Boolean(input.replayFrom)
  );
}

function backendFor(input: RunInput): RunnerBackend {
  const config = loadConfig();
  if (isRemoteRun(input)) {
    if (!config.remoteRunnerEnabled) {
      throw new RunnerError(
        'no_matching_runner',
        'runner: remote is requested but REMOTE_RUNNER is not enabled',
      );
    }
    return new RemoteRunnerBackend(config);
  }
  const kind =
    input.runner === 'local-process' || config.defaultRunner === 'local' ? 'local' : 'docker';
  return kind === 'docker'
    ? new DockerRunnerBackend({
        ...(config.runnerNetwork ? { network: config.runnerNetwork } : {}),
        workspaceMode: config.runnerWorkspaceMode,
      })
    : new LocalRunnerBackend();
}

/**
 * Records the secret *names* a run resolved (spec `secrets` › usage audit). Reads the
 * definition the run is pinned to, checks presence through the env provider (never the
 * value) and upserts `run_secrets` + `secret_usage`. Best effort: a missing definition
 * must not block the lease.
 */
async function recordRunSecretNames(input: RunInput): Promise<string[]> {
  let names: string[] = [];
  try {
    const { definition } = loadDefinition(input.factoryRoot);
    if (!definition) return names;
    const agents = definition.resources
      .filter((resource) => resource.kind === 'agent')
      .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
    names = [...new Set(collectSecretReferences(definition.manifest, agents).map((ref) => ref.name))];
  } catch {
    return names;
  }

  if (names.length === 0) return names;

  const resolves = envSecretResolver(process.env);
  try {
    await recordRunSecrets(getSql(), {
      runId: input.runId,
      secrets: names.map((name) => ({ name, resolved: resolves(name) })),
    });
  } catch (error) {
    console.warn(
      `[runner] secret usage not recorded for ${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return names;
}

export async function leaseRunner(args: {
  input: RunInput;
  /** Env for the harness process only — proxy base URL + per-run token, never a provider key. */
  harnessEnv?: Record<string, string>;
}): Promise<LeaseInfo> {
  const config = loadConfig();
  const existing = ephemeralLeases.get(args.input.runId);
  if (existing) return existing;

  // Secrets by name only (spec `secrets` › usage audit, ADR-026): the lease records which
  // names the run resolved so the Secrets page can show usage. A retried lease is
  // idempotent per `(runId, name)`.
  const secretNames = await recordRunSecretNames(args.input);

  const ephemeral = isEphemeralRun(args.input);
  const workspace = join(runDir(config.runsDir, args.input.runId), 'workspace');
  await mkdir(workspace, { recursive: true });

  if (ephemeral) {
    const lease: LeaseInfo = {
      runnerId: `factory-${args.input.runId}`,
      kind: 'local',
      workspace,
      ephemeral: true,
      sandbox: {
        mode: 'none',
        active: false,
        reason: args.input.replayFrom
          ? 'replay adapter (in-process)'
          : 'ephemeral adapter (in-process)',
      },
    };
    ephemeralLeases.set(args.input.runId, lease);
    await upsertStep({
      runId: args.input.runId,
      stepId: 'lease-runner',
      kind: 'runner',
      status: 'ok',
      detail: {
        ...lease,
        backend: args.input.replayFrom ? 'replay' : 'ephemeral',
        envKeys: [],
        secretNames,
        ...(args.input.replayFrom ? { replayFrom: args.input.replayFrom } : {}),
      },
    });
    return lease;
  }

  const backend = backendFor(args.input);
  // A downstream stage (review/verify) runs on the upstream stage's patch: the workspace
  // is a fresh checkout at the definition commit, so the implement diff is applied here
  // (host-side) before the sandbox starts.
  const patchFile = args.input.patchRunId
    ? patchPath(config.runsDir, args.input.patchRunId)
    : undefined;
  // A remote agent cannot read the central patch path; send the diff body instead.
  const patchContent =
    patchFile && existsSync(patchFile) && isRemoteRun(args.input)
      ? await readFile(patchFile, 'utf8')
      : undefined;
  if (isRemoteRun(args.input) && !args.input.repo?.url) {
    throw new RunnerError(
      'remote_repo_url_required',
      'remote runs need a clone URL (RUNNER_REPO_URL) because the agent cannot read the central checkout',
      { runId: args.input.runId },
    );
  }
  const runnerId = `factory-${args.input.runId}`;
  let leaseHeartbeatError: unknown;
  const leaseHeartbeat = setInterval(() => {
    try {
      // Docker build/run/readiness can take minutes. Heartbeats make Temporal able to
      // deliver cancellation to this activity while it is still leasing, instead of
      // discovering the cancellation only after a container already exists.
      activityHeartbeat({ step: 'lease-runner' });
    } catch (error) {
      leaseHeartbeatError = error;
    }
  }, 5_000);
  leaseHeartbeat.unref?.();

  let handle: RunnerHandle;
  try {
    handle = await backend.lease({
      runId: args.input.runId,
      repo: {
        path: args.input.repo?.path ?? args.input.factoryRoot,
        url: args.input.repo?.url,
        commit: args.input.repo?.commit ?? args.input.definitionCommit,
        ...(patchFile && existsSync(patchFile) && !isRemoteRun(args.input)
          ? { patch: patchFile }
          : {}),
        ...(patchContent !== undefined ? { patchContent } : {}),
      },
      harness: {
        command: harnessCommandWithProxyEnv(args.harnessEnv, args.input.runId),
        // opencode protects `/api/info` with the server password; the readiness probe
        // must authenticate or the lease waits 60s and fails on a healthy sandbox.
        ...(args.input.harness === 'opencode'
          ? { headers: harnessProbeHeaders(args.input.runId) }
          : {}),
      },
      keepWorkspace: false,
      runDir: runDir(config.runsDir, args.input.runId),
      // The local sandbox denies network unless the stage/factory grants it (task 6).
      networkPolicy: args.input.networkPolicy ?? 'denied',
      ...(isRemoteRun(args.input)
        ? {
            platform: config.remoteRunnerPlatform as 'linux' | 'windows' | 'macos',
            pool: config.remoteRunnerPool,
            tenant: 'default',
          }
        : {}),
    });

    if (leaseHeartbeatError) {
      // Cancellation arrived while the lease was completing. Remove the sandbox now so
      // the workflow's cleanup (which has no lease object) does not have to guess.
      await backend.kill(runnerId).catch(() => undefined);
      throw leaseHeartbeatError;
    }
  } catch (error) {
    // The lease may have created a container before failing. `kill` falls back to the
    // deterministic container name, so it also covers the no-lease path.
    await backend.kill(runnerId).catch(() => undefined);

    // A *requested* sandbox profile the host cannot honour fails the run here instead of
    // running unconfined (spec `runner-sandbox` › "Missing bwrap"). Record the same
    // `runner.sandbox_unavailable` identifier on the sandbox step so the run detail
    // explains the cause, then let the activity fail with the runner error code.
    if (isRunnerError(error) && error.code === 'runner.sandbox_unavailable') {
      const details = (error.details ?? {}) as { mode?: string };
      const detail = {
        event: 'runner.sandbox_unavailable',
        mode: details.mode ?? 'bwrap',
        active: false,
        platform: process.platform,
        reason: error.message,
        runId: args.input.runId,
      };
      await upsertStep({
        runId: args.input.runId,
        stepId: 'sandbox',
        kind: 'runner',
        status: 'error',
        detail,
        error: error.message,
      });
      const workItemMatch = /^run_([0-9A-HJKMNP-TV-Z]{26})(?:_|$)/.exec(args.input.runId);
      if (workItemMatch) {
        await appendWorkItemEvent(getSql(), {
          workItemId: `wi_${workItemMatch[1]}`,
          type: 'runner.sandbox_unavailable',
          actor: 'runner',
          payload: detail,
        }).catch(() => undefined);
      }
      console.warn(`[runner] runner.sandbox_unavailable ${JSON.stringify(detail)}`);
    }
    rethrowWithCause(error);
  } finally {
    clearInterval(leaseHeartbeat);
  }

  const lease: LeaseInfo = {
    runnerId: handle.runnerId,
    kind: handle.kind,
    workspace: handle.workspace,
    harnessUrl: handle.harnessUrl,
    ephemeral: false,
    ...(handle.sandbox ? { sandbox: handle.sandbox } : {}),
  };

  await upsertStep({
    runId: args.input.runId,
    stepId: 'lease-runner',
    kind: 'runner',
    status: 'ok',
    detail: {
      runnerId: lease.runnerId,
      kind: lease.kind,
      workspace: lease.workspace,
      harnessUrl: lease.harnessUrl,
      // Only key names are recorded — never values (ADR-009 / secret boundary).
      envKeys: Object.keys(args.harnessEnv ?? {}),
      envChannel: 'harness-command',
      secretNames,
      ...(handle.sandbox ? { sandbox: handle.sandbox } : {}),
      networkPolicy: args.input.networkPolicy ?? 'denied',
    },
  });

  // `RUNNER_SANDBOX=exec` was requested but this host has no sandbox backend: the run
  // proceeds unconfined and the lease step records `runner.sandbox_unavailable` explicitly
  // (task 6.2). The adapter event union is harness-owned, so this lives on the runner step.
  if (handle.sandbox && handle.sandbox.mode === 'exec' && !handle.sandbox.active) {
    const detail = {
      event: 'runner.sandbox_unavailable',
      mode: handle.sandbox.mode,
      active: false,
      platform: process.platform,
      reason: handle.sandbox.reason,
      runId: args.input.runId,
    };
    await upsertStep({
      runId: args.input.runId,
      stepId: 'sandbox',
      kind: 'runner',
      status: 'ok',
      detail,
    });
    // Stage runs carry the work item ULID in their run id; record the fallback in the loop
    // event log too, so the item detail shows why it ran unconfined.
    const workItemMatch = /^run_([0-9A-HJKMNP-TV-Z]{26})(?:_|$)/.exec(args.input.runId);
    if (workItemMatch) {
      await appendWorkItemEvent(getSql(), {
        workItemId: `wi_${workItemMatch[1]}`,
        type: 'runner.sandbox_unavailable',
        actor: 'runner',
        payload: detail,
      }).catch(() => undefined);
    }
    console.warn(`[runner] runner.sandbox_unavailable ${JSON.stringify(detail)}`);
  }

  return lease;
}

export interface CommandResult {
  exitCode: number;
  /** Path relative to the run directory, or null when nothing ran (fake harness). */
  logPath: string | null;
  bytes: number;
}

/**
 * Runs a setup/verification command inside the sandbox (never on the API host) and keeps
 * its stdout/stderr as a log artifact. Used for the definition runner's `setupCommands`;
 * Phase 3 will reuse it for stage verification commands.
 *
 * Canonical events are owned by the adapter's sequencer, so command output is not injected
 * into the event log: it lands in `runs/<runId>/artifacts/<stepId>.log` and the exit code
 * is recorded on the step.
 */
export async function runCommand(args: {
  input: RunInput;
  lease: LeaseInfo;
  command: string;
  stepId: string;
  timeoutMs?: number;
}): Promise<CommandResult> {
  if (args.lease.ephemeral) {
    await upsertStep({
      runId: args.input.runId,
      stepId: args.stepId,
      kind: 'exec',
      status: 'ok',
      detail: { skipped: 'ephemeral runner', command: args.command },
    });
    return { exitCode: 0, logPath: null, bytes: 0 };
  }

  const config = loadConfig();
  const backend = backendFor(args.input);
  const chunks: string[] = [];
  let exitCode = 0;

  try {
    for await (const event of backend.exec(args.lease.runnerId, {
      command: args.command,
      timeoutMs: args.timeoutMs ?? 10 * 60 * 1000,
    })) {
      if (event.type === 'stdout' || event.type === 'stderr') chunks.push(event.data);
      if (event.type === 'exit') exitCode = event.code;
      if (event.type === 'error') {
        chunks.push(`[${event.code}] ${event.message}\n`);
        exitCode = 1;
      }
      heartbeat({ stepId: args.stepId, exitCode });
    }
  } catch (error) {
    rethrowWithCause(error);
  }

  const logPath = join(artifactsDir(config.runsDir, args.input.runId), `${args.stepId}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const body = chunks.join('');
  await writeFile(logPath, body, 'utf8');

  await upsertStep({
    runId: args.input.runId,
    stepId: args.stepId,
    kind: 'exec',
    status: exitCode === 0 ? 'ok' : 'error',
    detail: {
      command: args.command,
      exitCode,
      logPath: `artifacts/${args.stepId}.log`,
      bytes: Buffer.byteLength(body),
    },
    error: exitCode === 0 ? null : `command exited with ${exitCode}`,
  });

  return {
    exitCode,
    logPath: `artifacts/${args.stepId}.log`,
    bytes: Buffer.byteLength(body),
  };
}

export interface ArtifactResult {
  artifacts: RunArtifact[];
  usage: UsageReport | null;
}

export async function collectArtifacts(args: {
  input: RunInput;
  lease: LeaseInfo;
}): Promise<ArtifactResult> {
  const config = loadConfig();
  const dir = await ensureRunDir(config.runsDir, args.input.runId);
  const artifacts: RunArtifact[] = [];
  let usage: UsageReport | null = null;

  const entry = getSession(args.input.runId);
  if (entry) {
    try {
      usage = await entry.adapter.getUsage(entry.handle);
    } catch {
      usage = null;
    }
  }

  if (args.lease.ephemeral) {
    // Scripted adapter: no workspace diff to capture, so persist the adapter's diff.
    const adapter = entry?.adapter ?? createAdapter('fake', {});
    const handle: SessionHandle =
      entry?.handle ?? { adapterId: 'fake', runId: args.input.runId };
    let diffs: { path: string; diff: string }[] = [];
    try {
      diffs = await adapter.getDiff(handle);
    } catch {
      diffs = [];
    }
    const patch = diffs.map((diff) => diff.diff).join('\n');
    const patchFile = patchPath(config.runsDir, args.input.runId);
    await writeFile(patchFile, patch, 'utf8');
    const bytes = Buffer.byteLength(patch);
    artifacts.push({
      path: 'patch.diff',
      bytes,
      sha256: createHash('sha256').update(patch).digest('hex'),
      kind: 'patch',
    });

    if (usage) {
      const usageFile = join(artifactsDir(config.runsDir, args.input.runId), 'usage.json');
      await mkdir(dirname(usageFile), { recursive: true });
      const body = JSON.stringify(usage, null, 2);
      await writeFile(usageFile, body, 'utf8');
      artifacts.push({
        path: 'artifacts/usage.json',
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        kind: 'log',
      });
    }
  } else {
    const backend = backendFor(args.input);
    if (isRemoteRun(args.input)) {
      const collected = await (backend as RemoteRunnerBackend)
        .collect(args.lease.runnerId, { destDir: dir, includeGitDiff: true })
        .catch(rethrowWithCause);
      for (const artifact of collected.artifacts) {
        artifacts.push({
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          kind: artifact.kind,
        });
      }
      if (collected.usage) usage = collected.usage as UsageReport;
    } else {
      const collected: Artifact[] = await backend
        .artifacts(args.lease.runnerId, { destDir: dir, includeGitDiff: true })
        .catch(rethrowWithCause);
      for (const artifact of collected) {
        artifacts.push({
          path: artifact.path,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          kind: artifact.kind,
        });
      }
    }
    // Verify the patch exists even when the backend reported nothing (empty diff is fine).
    try {
      await readFile(patchPath(config.runsDir, args.input.runId));
    } catch {
      await writeFile(patchPath(config.runsDir, args.input.runId), '', 'utf8');
    }
  }

  heartbeat({ artifacts: artifacts.length });
  await upsertStep({
    runId: args.input.runId,
    stepId: 'collect-artifacts',
    kind: 'artifacts',
    status: 'ok',
    detail: { artifacts, usage },
  });

  return { artifacts, usage };
}

/** Stops and removes the sandbox; the run directory is retained. Idempotent. */
export async function killRunner(args: { input: RunInput; lease?: LeaseInfo }): Promise<void> {
  const lease = args.lease ?? ephemeralLeases.get(args.input.runId);
  if (!lease) {
    // Cancellation can arrive before the lease activity returns a handle. The container
    // name is deterministic, so a best-effort kill still covers that path. Ephemeral runs
    // have no sandbox at all.
    if (!isEphemeralRun(args.input)) {
      const backend = backendFor(args.input);
      await backend.kill(`factory-${args.input.runId}`).catch((error: unknown) => {
        console.warn(
          `[runner] orphan kill failed for ${args.input.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      await upsertStep({
        runId: args.input.runId,
        stepId: 'kill-runner',
        kind: 'runner',
        status: 'ok',
        detail: { runnerId: `factory-${args.input.runId}`, orphanCleanup: true },
      }).catch(() => undefined);
    }
    ephemeralLeases.delete(args.input.runId);
    await dropSession(args.input.runId);
    return;
  }
  if (lease.ephemeral) {
    ephemeralLeases.delete(args.input.runId);
    await dropSession(args.input.runId);
    return;
  }
  const backend = backendFor(args.input);
  await backend.kill(lease.runnerId).catch(rethrowWithCause);
  // Release the in-worker adapter session so a long-lived worker does not accumulate runs.
  await dropSession(args.input.runId);
  await upsertStep({
    runId: args.input.runId,
    stepId: 'kill-runner',
    kind: 'runner',
    status: 'ok',
    detail: { runnerId: lease.runnerId },
  });
}

/** Test hook. */
export function clearEphemeralLeases(): void {
  ephemeralLeases.clear();
}
