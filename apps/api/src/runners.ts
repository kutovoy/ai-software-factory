import type { Hono } from 'hono';
import { z } from 'zod';
import {
  ackAlert,
  createEnrollment,
  deleteHost,
  drainHost,
  getAlertView,
  getEnrollment,
  getHost,
  listAlertRules,
  listAlerts,
  listHosts,
  listLeases,
  listMetrics,
  replaceAlertRules,
  silenceAlert,
  type RunnerAlertRuleRecord,
  type RunnerAlertView,
  type RunnerEnrollmentRecord,
  type RunnerHostRecord,
  type RunnerHostView,
} from '@factory/orchestration';
import type { RunnerHostPlatform } from '@factory/runners';
import {
  canAccess,
  sessionUserId,
  viewerOf,
  type AuthVariables,
  type Viewer,
} from './auth';
import type { ApiConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { log } from './logger';

/**
 * Runner control-plane routes (spec `remote-runners`, `runner-observability`).
 *
 * Everything here is console-facing and owner-scoped: a member sees the hosts they
 * enrolled, an admin sees every host. Enrollment tokens are one-time secrets — the create
 * response carries the plaintext once, and the install command puts it in an environment
 * variable, never in the command arguments (process listings are world-readable).
 */

/** Enrollment links stay valid for a day: long enough to install, short enough to expire. */
const ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;

export const enrollmentBodySchema = z
  .object({
    name: z.string().min(1).max(64),
    platform: z.enum(['linux', 'windows', 'macos']),
    arch: z.string().min(1).max(32),
    pool: z.string().min(1).max(64).optional(),
    labels: z.record(z.string().max(120)).optional(),
    maxConcurrent: z.number().int().min(1).max(64).optional(),
  })
  .strict();

export type EnrollmentBody = z.infer<typeof enrollmentBodySchema>;

const drainBodySchema = z.object({ drain: z.boolean() }).strict();

const silenceBodySchema = z
  .object({ until: z.string().min(1).max(64) })
  .strict();

const alertRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    scope: z.enum(['global', 'pool', 'host']),
    hostId: z.string().min(1).max(64).nullable().optional(),
    pool: z.string().min(1).max(64).nullable().optional(),
    metric: z.string().min(1).max(64),
    comparison: z.enum(['gt', 'lt']),
    threshold: z.number(),
    durationSeconds: z.number().int().min(0).max(86_400),
    severity: z.enum(['warning', 'critical']),
    channel: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const alertRulesBodySchema = z
  .object({ rules: z.array(alertRuleSchema).max(100) })
  .strict();

export type AlertRulesBody = z.infer<typeof alertRulesBodySchema>;

/** Reads and validates a JSON body; every failure is the stable `invalid_request` code. */
export async function readJsonBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalidRequest('request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidRequest('invalid request body', parsed.error.issues);
  return parsed.data;
}

/** Single-quotes a shell argument so names, labels and URLs survive `sh -c`. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quotes a PowerShell literal; an embedded `'` doubles. */
function psq(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escapes `\` and `"` for a bash-built JSON string and drops newlines. */
const BASH_JSON_ESCAPE = [
  'json_escape() {',
  '  printf \'%s\' "$1" | sed -e \'s/\\\\/\\\\\\\\/g\' -e \'s/"/\\\\"/g\' | tr -d \'\\n\'',
  '}',
  'check_json() { printf \'{"ok":%s,"detail":"%s"}\' "$1" "$(json_escape "$2")"; }',
].join('\n');

function runnerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'runner';
}

/**
 * The preflight script the operator runs on the target host **before** installing the
 * agent. It checks the tools the selected platform's agent needs, then posts the result to
 * the enrollment so the console can show pass/fail while the operator is still on that
 * machine: docker/git/curl/disk on Linux, git/curl/Bun/Xcode CLT/disk/sandbox-exec on macOS
 * and PowerShell/git/Bun/disk (plus optional dotnet/MSBuild) on Windows.
 */
export function preflightCommand(
  apiBase: string,
  token: string,
  platform: RunnerHostPlatform = 'linux',
): string {
  const url = `${apiBase.replace(/\/+$/, '')}/api/v1/runner-enrollments/${token}/preflight`;
  if (platform === 'windows') return windowsPreflight(url);
  if (platform === 'macos') return macosPreflight(url);
  return linuxPreflight(url);
}

function linuxPreflight(url: string): string {
  return [
    '#!/usr/bin/env bash',
    '# Runner preflight: verifies the tools the agent needs and reports to the control plane.',
    'set -u',
    `API_URL=${shq(url)}`,
    "PLATFORM='linux'",
    'docker_ok=false; docker_detail="docker not found"',
    'if command -v docker >/dev/null 2>&1; then',
    "  docker_detail=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'daemon unreachable')",
    '  docker version >/dev/null 2>&1 && docker_ok=true',
    'fi',
    'git_ok=false; git_detail="git not found"',
    'if command -v git >/dev/null 2>&1; then',
    '  git_detail=$(git --version 2>/dev/null || echo "git unavailable"); git_ok=true',
    'fi',
    'curl_ok=false',
    'command -v curl >/dev/null 2>&1 && curl_ok=true',
    'free_kb=$(df -Pk . 2>/dev/null | awk \'NR==2 {print $4}\')',
    'disk_ok=false',
    'if [ -n "${free_kb:-}" ] && [ "$free_kb" -ge 5242880 ]; then disk_ok=true; fi',
    'payload=$(printf \'{"platform":"%s","checks":{"docker":{"ok":%s,"detail":"%s"},"git":{"ok":%s,"detail":"%s"},"disk":{"ok":%s,"detail":"%s KB free"},"curl":{"ok":%s}}}\' \\',
    '  "$PLATFORM" "$docker_ok" "${docker_detail//\\"/}" "$git_ok" "${git_detail//\\"/}" "$disk_ok" "${free_kb:-0}" "$curl_ok")',
    'curl -fsS -X POST "$API_URL" -H \'content-type: application/json\' -d "$payload"',
    'echo',
    'echo "Preflight reported. The console shows pass/fail for this enrollment."',
  ].join('\n');
}

function macosPreflight(url: string): string {
  return [
    '#!/usr/bin/env bash',
    '# Runner preflight (macOS): checks git, curl, Bun, Xcode command-line tools, free disk',
    '# and sandbox-exec, then posts the result to the enrollment.',
    'set -u',
    `API_URL=${shq(url)}`,
    "PLATFORM='macos'",
    BASH_JSON_ESCAPE,
    'git_ok=false; git_detail="git not found"',
    'if command -v git >/dev/null 2>&1; then',
    '  git_detail=$(git --version 2>/dev/null || echo "git unavailable"); git_ok=true',
    'fi',
    'curl_ok=false',
    'command -v curl >/dev/null 2>&1 && curl_ok=true',
    'bun_ok=false; bun_detail="bun not found"',
    'if command -v bun >/dev/null 2>&1; then',
    '  bun_detail=$(bun --version 2>/dev/null || echo "bun unavailable"); bun_ok=true',
    'fi',
    'xcode_ok=false; xcode_detail="Xcode command-line tools not installed"',
    'if command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then',
    '  xcode_detail=$(xcode-select -p 2>/dev/null); xcode_ok=true',
    'fi',
    'sandbox_ok=false; sandbox_detail="/usr/bin/sandbox-exec missing"',
    'if [ -x /usr/bin/sandbox-exec ]; then sandbox_ok=true; sandbox_detail="sandbox-exec available"; fi',
    'free_kb=$(df -Pk . 2>/dev/null | awk \'NR==2 {print $4}\')',
    'disk_ok=false',
    'if [ -n "${free_kb:-}" ] && [ "$free_kb" -ge 5242880 ]; then disk_ok=true; fi',
    'payload=$(printf \'{"platform":"%s","checks":{"git":%s,"curl":%s,"bun":%s,"xcode":%s,"sandbox":%s,"disk":%s}}\' \\',
    '  "$PLATFORM" "$(check_json "$git_ok" "$git_detail")" "$(check_json "$curl_ok" "curl available")" \\',
    '  "$(check_json "$bun_ok" "$bun_detail")" "$(check_json "$xcode_ok" "$xcode_detail")" \\',
    '  "$(check_json "$sandbox_ok" "$sandbox_detail")" "$(check_json "$disk_ok" "${free_kb:-0} KB free")")',
    'curl -fsS -X POST "$API_URL" -H \'content-type: application/json\' -d "$payload"',
    'echo',
    'echo "Preflight reported. The console shows pass/fail for this enrollment."',
  ].join('\n');
}

function windowsPreflight(url: string): string {
  return [
    '# Runner preflight (Windows): checks PowerShell, git, Bun, free disk and optional dotnet/MSBuild.',
    '# Run it in PowerShell; it posts the check map to the enrollment.',
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$apiUrl = ${psq(url)}`,
    "$platform = 'windows'",
    '',
    '$psCheck = @{ ok = $true; detail = "PowerShell $($PSVersionTable.PSVersion)" }',
    '$git = Get-Command git -ErrorAction SilentlyContinue',
    'if ($git) { $gitCheck = @{ ok = $true; detail = ((& git --version 2>$null) -join " ").Trim() } }',
    'else { $gitCheck = @{ ok = $false; detail = "git not found" } }',
    '$bun = Get-Command bun -ErrorAction SilentlyContinue',
    'if ($bun) { $bunCheck = @{ ok = $true; detail = ((& bun --version 2>$null) -join " ").Trim() } }',
    'else { $bunCheck = @{ ok = $false; detail = "bun not found" } }',
    '',
    '# dotnet/MSBuild are optional for a native Windows agent: reported, never blocking.',
    '$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue',
    'if ($dotnet) { $dotnetCheck = @{ ok = $true; detail = ((& dotnet --version 2>$null) -join " ").Trim() } }',
    'else { $dotnetCheck = @{ ok = $true; detail = "dotnet not installed (optional)" } }',
    '$msbuild = Get-Command msbuild -ErrorAction SilentlyContinue',
    'if ($msbuild) { $msbuildCheck = @{ ok = $true; detail = $msbuild.Source } }',
    'else { $msbuildCheck = @{ ok = $true; detail = "MSBuild not installed (optional)" } }',
    '',
    '$drive = (Get-Item -LiteralPath $env:TEMP).PSDrive.Name',
    '$freeBytes = [int64](Get-PSDrive -Name $drive -ErrorAction SilentlyContinue).Free',
    '$diskCheck = @{ ok = ($freeBytes -ge 5GB); detail = "$freeBytes bytes free on $drive" }',
    '',
    '$checks = [ordered]@{',
    '  powershell = $psCheck',
    '  git = $gitCheck',
    '  bun = $bunCheck',
    '  dotnet = $dotnetCheck',
    '  msbuild = $msbuildCheck',
    '  disk = $diskCheck',
    '}',
    '$body = @{ platform = $platform; checks = $checks } | ConvertTo-Json -Depth 5 -Compress',
    "Invoke-RestMethod -Method Post -Uri $apiUrl -ContentType 'application/json' -Body $body",
    "Write-Host 'Preflight reported. The console shows pass/fail for this enrollment.'",
  ].join('\n');
}

/**
 * Install command generation. Linux keeps the containerised agent (docker socket + data
 * volume); Windows and macOS run the agent natively from a repository checkout, installing
 * Bun when it is missing. The enrollment token is always an environment variable, never an
 * argument, and no provider credential is ever part of the command.
 */
export function installCommand(input: {
  apiBase: string;
  token: string;
  name: string;
  platform: RunnerHostPlatform;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
}): string {
  if (input.platform === 'windows') return windowsInstall(input);
  if (input.platform === 'macos') return macosInstall(input);
  return linuxInstall(input);
}

function linuxInstall(input: {
  apiBase: string;
  token: string;
  name: string;
  platform: RunnerHostPlatform;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
}): string {
  const slug = runnerSlug(input.name);
  const apiBase = input.apiBase.replace(/\/+$/, '');
  return [
    `# MVP install: run this from a checkout of this repository on the Linux host.`,
    `# The agent image has Bun, git and the Docker CLI; the socket lets it create one`,
    `# sandbox container per run. The enrollment token travels in the environment.`,
    `docker build -t factory-runner-agent:local -f packages/runners/agent.Dockerfile .`,
    `docker network create factory-runners 2>/dev/null || true`,
    `docker run -d \\`,
    `  --name ${shq(`factory-runner-${slug}`)} \\`,
    `  --restart unless-stopped \\`,
    `  --network factory-runners \\`,
    `  --add-host host.docker.internal:host-gateway \\`,
    `  -v /var/run/docker.sock:/var/run/docker.sock \\`,
    `  -v ${shq(`factory-runner-${slug}-data`)}:/data \\`,
    `  -e FACTORY_API_URL=${shq(apiBase)} \\`,
    `  -e RUNNER_ENROLLMENT_TOKEN=${shq(input.token)} \\`,
    `  -e RUNNER_STATE_FILE=/data/runner-agent.json \\`,
    `  -e RUNNER_NAME=${shq(input.name)} \\`,
    `  -e RUNNER_PLATFORM=${shq(input.platform)} \\`,
    `  -e RUNNER_POOL=${shq(input.pool)} \\`,
    `  -e RUNNER_LABELS=${shq(JSON.stringify(input.labels))} \\`,
    `  -e RUNNER_MAX_CONCURRENT=${shq(String(input.maxConcurrent))} \\`,
    `  -e RUNNER_WORKSPACE_MODE=copy \\`,
    `  -e RUNNER_DOCKER_NETWORK=factory-runners \\`,
    `  factory-runner-agent:local`,
  ].join('\n');
}

function macosInstall(input: {
  apiBase: string;
  token: string;
  name: string;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
}): string {
  const apiBase = input.apiBase.replace(/\/+$/, '');
  return [
    '# Native macOS agent install: run this from a checkout of this repository.',
    '# The agent uses the process backend under sandbox-exec; a launchd service wrapper is',
    '# a documented follow-up. The enrollment token travels in the environment.',
    'set -euo pipefail',
    `export FACTORY_API_URL=${shq(apiBase)}`,
    `export RUNNER_ENROLLMENT_TOKEN=${shq(input.token)}`,
    'export RUNNER_STATE_FILE="$HOME/.factory-runner/runner-agent.json"',
    `export RUNNER_NAME=${shq(input.name)}`,
    "export RUNNER_PLATFORM='macos'",
    `export RUNNER_POOL=${shq(input.pool)}`,
    `export RUNNER_LABELS=${shq(JSON.stringify(input.labels))}`,
    `export RUNNER_MAX_CONCURRENT=${shq(String(input.maxConcurrent))}`,
    'export RUNNER_BACKEND=local',
    'export RUNNER_SANDBOX=exec',
    'if ! command -v bun >/dev/null 2>&1; then',
    '  curl -fsSL https://bun.sh/install | bash',
    '  export PATH="$HOME/.bun/bin:$PATH"',
    'fi',
    'mkdir -p "$HOME/.factory-runner"',
    'LOG="$HOME/.factory-runner/agent.log"',
    'PID_FILE="$HOME/.factory-runner/agent.pid"',
    'nohup bun packages/runners/src/agent.ts >>"$LOG" 2>&1 &',
    'echo $! > "$PID_FILE"',
    'echo "Agent started (pid $(cat "$PID_FILE")); logs: $LOG"',
  ].join('\n');
}

function windowsInstall(input: {
  apiBase: string;
  token: string;
  name: string;
  pool: string;
  labels: Record<string, string>;
  maxConcurrent: number;
}): string {
  const apiBase = input.apiBase.replace(/\/+$/, '');
  return [
    '# Native Windows agent install: run this in PowerShell from a checkout of this repository.',
    '# The agent starts hidden with Start-Process; a Windows service wrapper is a follow-up.',
    "$ErrorActionPreference = 'Stop'",
    `$env:FACTORY_API_URL = ${psq(apiBase)}`,
    `$env:RUNNER_ENROLLMENT_TOKEN = ${psq(input.token)}`,
    '$env:RUNNER_STATE_FILE = "$env:LOCALAPPDATA\\factory-runner\\runner-agent.json"',
    `$env:RUNNER_NAME = ${psq(input.name)}`,
    "$env:RUNNER_PLATFORM = 'windows'",
    `$env:RUNNER_POOL = ${psq(input.pool)}`,
    `$env:RUNNER_LABELS = ${psq(JSON.stringify(input.labels))}`,
    `$env:RUNNER_MAX_CONCURRENT = ${psq(String(input.maxConcurrent))}`,
    "$env:RUNNER_BACKEND = 'local'",
    "$agentDir = Join-Path $env:LOCALAPPDATA 'factory-runner'",
    'New-Item -ItemType Directory -Force -Path $agentDir | Out-Null',
    'if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {',
    '  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"',
    "  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'Machine')",
    '}',
    '$bun = (Get-Command bun -ErrorAction Stop).Source',
    "$log = Join-Path $agentDir 'agent.log'",
    "$errLog = Join-Path $agentDir 'agent.err.log'",
    "$pidFile = Join-Path $agentDir 'agent.pid'",
    "$agentProcess = Start-Process -FilePath $bun -ArgumentList 'packages/runners/src/agent.ts' -WorkingDirectory (Get-Location) -RedirectStandardOutput $log -RedirectStandardError $errLog -WindowStyle Hidden -PassThru",
    'Set-Content -Path $pidFile -Value $agentProcess.Id',
    'Write-Host "Agent started (pid $($agentProcess.Id)); logs: $log"',
  ].join('\n');
}

function enrollmentInvalid(message: string, details?: unknown): ApiError {
  return new ApiError('enrollment_invalid', 404, message, details);
}

function runnerNotFound(id: string): ApiError {
  return new ApiError('runner_not_found', 404, `runner "${id}" does not exist`, { id });
}

function alertNotFound(id: string): ApiError {
  return new ApiError('alert_not_found', 404, `alert "${id}" does not exist`, { id });
}

function actorOf(viewer: Viewer | null): string {
  return viewer?.username ?? 'local';
}

function rulesFromBody(
  body: AlertRulesBody,
): Array<Omit<RunnerAlertRuleRecord, 'createdAt'>> {
  return body.rules.map((rule) => ({
    id: rule.id,
    scope: rule.scope,
    hostId: rule.hostId ?? null,
    pool: rule.pool ?? null,
    metric: rule.metric,
    comparison: rule.comparison,
    threshold: rule.threshold,
    durationSeconds: rule.durationSeconds,
    severity: rule.severity,
    channel: rule.channel ?? 'inbox',
    enabled: rule.enabled ?? true,
  }));
}


/** The console host projection: raw metrics plus the three load gauges and alert count. */
function hostWire(
  host: RunnerHostRecord & {
    activeLeases?: number;
    latestMetrics?: RunnerHostView['latestMetrics'];
    firingAlerts?: number;
  },
): Record<string, unknown> {
  const metrics = host.latestMetrics ?? host.metrics ?? null;
  const diskUsedPercent =
    metrics && metrics.disks.length > 0
      ? Math.max(...metrics.disks.map((disk) => disk.usedPercent))
      : null;
  return {
    ...host,
    cpuPercent: metrics?.cpuPercent ?? null,
    memoryUsedPercent: metrics?.memoryUsedPercent ?? null,
    diskUsedPercent,
    alertCount: host.firingAlerts ?? 0,
    activeLeases: host.activeLeases ?? 0,
    metrics,
  };
}

function alertWire(alert: RunnerAlertView): Record<string, unknown> {
  return { ...alert, hostName: alert.hostName ?? alert.hostId };
}

/**
 * The enrollment read shape: the stored preflight is a check map, the console renders a
 * status plus an ordered list. The one-time token and commands are only on the create
 * response; this projection deliberately omits them.
 */
function enrollmentWire(enrollment: RunnerEnrollmentRecord): Record<string, unknown> {
  const preflight = enrollment.preflight;
  const checks = preflight
    ? Object.entries(preflight.checks).map(([id, check]) => ({
        id,
        label: id,
        ok: check.ok,
        detail: check.detail ?? null,
      }))
    : [];
  return {
    ...enrollment,
    preflight: preflight
      ? {
          status: checks.every((check) => check.ok) ? 'passed' : 'failed',
          checks,
          checkedAt: null,
          message: preflight.platform,
        }
      : null,
  };
}

/** Registers the console-facing runner routes on the auth-protected versioned router. */
export function registerRunners(
  api: Hono<{ Variables: AuthVariables }>,
  config: ApiConfig,
): void {
  const apiBase = config.webhookPublicUrl;

  /* -------------------------------------------------------------- hosts */

  api.get('/runners', async (c) => {
    const hosts: RunnerHostView[] = await listHosts(viewerOf(config, c.get('user')));
    return c.json({ hosts: hosts.map(hostWire) });
  });

  /* --------------------------------------------------------- enrollments */

  api.post('/runners/enrollments', async (c) => {
    const body = await readJsonBody<EnrollmentBody>(c, enrollmentBodySchema);
    const enrollment = await createEnrollment({
      name: body.name,
      platform: body.platform,
      arch: body.arch,
      ...(body.pool ? { pool: body.pool } : {}),
      ...(body.labels ? { labels: body.labels } : {}),
      ...(body.maxConcurrent ? { maxConcurrent: body.maxConcurrent } : {}),
      owner: sessionUserId(config, c.get('user')),
      ttlMs: ENROLLMENT_TTL_MS,
    });

    log('info', 'runner_enrollment_created', {
      enrollmentId: enrollment.id,
      name: body.name,
      platform: body.platform,
    });

    // The plaintext token is returned exactly once; only its hash is stored.
    return c.json(
      {
        enrollment: {
          id: enrollment.id,
          name: body.name,
          platform: body.platform,
          arch: body.arch,
          pool: body.pool ?? 'default',
          labels: body.labels ?? {},
          maxConcurrent: body.maxConcurrent ?? 1,
          usedAt: null,
          token: enrollment.token,
          expiresAt: enrollment.expiresAt,
          preflightCommand: preflightCommand(apiBase, enrollment.token, body.platform),
          installCommand: installCommand({
            apiBase,
            token: enrollment.token,
            name: body.name,
            platform: body.platform,
            pool: body.pool ?? 'default',
            labels: body.labels ?? {},
            maxConcurrent: body.maxConcurrent ?? 1,
          }),
        },
      },
      201,
    );
  });

  api.get('/runners/enrollments/:id', async (c) => {
    const id = c.req.param('id');
    const enrollment = await getEnrollment(id);
    if (!enrollment) throw enrollmentInvalid(`enrollment "${id}" does not exist`, { id });
    if (!canAccess(viewerOf(config, c.get('user')), enrollment.owner)) {
      throw enrollmentInvalid(`enrollment "${id}" does not exist`, { id });
    }
    return c.json({ enrollment: enrollmentWire(enrollment) });
  });

  /* ---------------------------------------------------------- host detail */

  api.get('/runners/:id', async (c) => {
    const id = c.req.param('id');
    const viewer = viewerOf(config, c.get('user'));
    const host = await getHost(id, viewer);
    if (!host) throw runnerNotFound(id);

    const [metrics, leases, alerts] = await Promise.all([
      listMetrics(id, '1h'),
      listLeases(id),
      listAlerts(viewer, { hostId: id, limit: 50 }),
    ]);
    return c.json({
      host: hostWire({
        ...host,
        activeLeases: leases.filter((lease) => lease.state === 'active').length,
        latestMetrics: host.metrics,
        firingAlerts: alerts.filter((alert) => alert.resolvedAt === null).length,
      }),
      metrics,
      leases,
      alerts: alerts.map(alertWire),
    });
  });

  api.get('/runners/:id/metrics', async (c) => {
    const id = c.req.param('id');
    const viewer = viewerOf(config, c.get('user'));
    const host = await getHost(id, viewer);
    if (!host) throw runnerNotFound(id);
    const samples = await listMetrics(id, c.req.query('window') ?? '1h');
    return c.json({ hostId: id, samples });
  });

  api.post('/runners/:id/drain', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody<{ drain: boolean }>(c, drainBodySchema);
    const viewer = viewerOf(config, c.get('user'));
    if (!(await getHost(id, viewer))) throw runnerNotFound(id);
    const host = await drainHost(id, body.drain);
    if (!host) throw runnerNotFound(id);
    log('info', 'runner_drain_changed', { hostId: id, drain: body.drain });
    return c.json({
      host: hostWire({
        ...host,
        activeLeases: 0,
        latestMetrics: host.metrics,
        firingAlerts: 0,
      }),
    });
  });

  api.delete('/runners/:id', async (c) => {
    const id = c.req.param('id');
    const viewer = viewerOf(config, c.get('user'));
    if (!(await getHost(id, viewer))) throw runnerNotFound(id);
    await deleteHost(id);
    log('info', 'runner_deleted', { hostId: id });
    return c.json({ deleted: true });
  });

  /* -------------------------------------------------------------- alerts */

  api.get('/runner-alerts', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    const state = c.req.query('state');
    const alerts = await listAlerts(viewerOf(config, c.get('user')), {
      ...(state ? { state: state as RunnerAlertView['state'] } : {}),
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json({ alerts: alerts.map(alertWire) });
  });

  api.post('/runner-alerts/:id/ack', async (c) => {
    const id = c.req.param('id');
    const viewer = viewerOf(config, c.get('user'));
    const existing = await getAlertView(id);
    if (!existing || !(await getHost(existing.hostId, viewer))) throw alertNotFound(id);
    const actor = actorOf(viewer);
    const alert = await ackAlert(id, actor);
    if (!alert) throw alertNotFound(id);
    log('info', 'runner_alert_acknowledged', { alertId: id, actor });
    return c.json({ alert: alertWire(alert) });
  });

  api.post('/runner-alerts/:id/silence', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody<{ until: string }>(c, silenceBodySchema);
    const untilMs = Date.parse(body.until);
    if (!Number.isFinite(untilMs)) {
      throw invalidRequest('`until` must be an ISO timestamp', { until: body.until });
    }
    if (untilMs <= Date.now()) {
      throw invalidRequest('`until` must be in the future', { until: body.until });
    }
    const viewer = viewerOf(config, c.get('user'));
    const existing = await getAlertView(id);
    if (!existing || !(await getHost(existing.hostId, viewer))) throw alertNotFound(id);
    const actor = actorOf(viewer);
    const alert = await silenceAlert(id, new Date(untilMs).toISOString(), actor);
    if (!alert) throw alertNotFound(id);
    log('info', 'runner_alert_silenced', { alertId: id, until: body.until, actor });
    return c.json({ alert: alertWire(alert) });
  });

  /* --------------------------------------------------------- alert rules */

  api.get('/runner-alert-rules', async (c) => c.json({ rules: await listAlertRules() }));

  api.put('/runner-alert-rules', async (c) => {
    const viewer = viewerOf(config, c.get('user'));
    if (viewer && viewer.role !== 'admin') {
      throw new ApiError('forbidden', 403, 'admin role required to edit alert rules', {
        role: viewer.role,
      });
    }
    const body = await readJsonBody<AlertRulesBody>(c, alertRulesBodySchema);
    const rules = await replaceAlertRules(rulesFromBody(body));
    log('info', 'runner_alert_rules_replaced', { count: rules.length, actor: actorOf(viewer) });
    return c.json({ rules });
  });
}
