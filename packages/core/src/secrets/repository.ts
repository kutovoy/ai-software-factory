import type { SQL } from 'bun';
import type { SecretReference } from './references';

/**
 * Secret registry (spec `secrets`, ADR-026).
 *
 * The registry stores **metadata only**: a name, where the value is expected to live
 * (`provider`), its scope, a description and rotation timestamps. A `value` field is
 * rejected with `secret_value_rejected`; nothing here can read a value back out, and the
 * presence check reports `resolved` / `unresolved` without returning the value.
 */

export const SECRET_PROVIDERS = ['env', 'managed'] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const SECRET_SCOPES = ['factory', 'workspace', 'global'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export type SecretStatus = 'resolved' | 'unresolved';

export interface SecretRecord {
  name: string;
  provider: SecretProvider;
  scope: SecretScope;
  description: string | null;
  lastRotatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SecretUsageRecord {
  secretName: string;
  useCount: number;
  lastRunId: string | null;
  lastUsedAt: string | null;
}

export interface SecretUsageEntry {
  runId: string;
  resolved: boolean;
  recordedAt: string | null;
}

export class SecretRegistryError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'SecretRegistryError';
    this.code = code;
    this.details = details;
  }
}

interface SecretRow {
  name: string;
  provider: string;
  scope: string;
  description: string | null;
  last_rotated_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface UsageRow {
  secret_name: string;
  use_count: number | string;
  last_run_id: string | null;
  last_used_at: unknown;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mapSecret(row: SecretRow): SecretRecord {
  return {
    name: row.name,
    provider: row.provider as SecretProvider,
    scope: row.scope as SecretScope,
    description: row.description,
    lastRotatedAt: iso(row.last_rotated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUsage(row: UsageRow): SecretUsageRecord {
  return {
    secretName: row.secret_name,
    useCount: Number(row.use_count),
    lastRunId: row.last_run_id,
    lastUsedAt: iso(row.last_used_at),
  };
}

/** Default presence check: the runtime environment (name, upper-case, `SECRET_` prefix). */
export function envSecretResolver(env: NodeJS.ProcessEnv = process.env): (name: string) => boolean {
  return (name: string): boolean => {
    const value =
      env[name] ?? env[name.toUpperCase()] ?? env[`SECRET_${name.toUpperCase()}`];
    return typeof value === 'string' && value.length > 0;
  };
}

export interface RegisterSecretArgs {
  name: string;
  provider?: SecretProvider;
  scope?: SecretScope;
  description?: string | null;
  /** Forbidden: the registry stores names, never values. */
  value?: unknown;
}

export interface RegisterSecretOptions {
  /** Presence check. Defaults to the process environment. Never returns the value. */
  resolves?: (name: string) => boolean;
}

export interface RegisteredSecret {
  secret: SecretRecord;
  status: SecretStatus;
}

function assertNoValue(args: RegisterSecretArgs): void {
  if (Object.prototype.hasOwnProperty.call(args, 'value') && args.value !== undefined) {
    throw new SecretRegistryError(
      'secret_value_rejected',
      'the registry stores secret names, not values; provide the value through the environment',
      { name: args.name },
    );
  }
}

export async function registerSecret(
  sql: SQL,
  args: RegisterSecretArgs,
  options: RegisterSecretOptions = {},
): Promise<RegisteredSecret> {
  assertNoValue(args);
  const resolves = options.resolves ?? envSecretResolver();

  const rows = (await sql`
    insert into secrets (name, provider, scope, description, updated_at)
    values (
      ${args.name}, ${args.provider ?? 'env'}, ${args.scope ?? 'factory'},
      ${args.description ?? null}, now()
    )
    on conflict (name) do update set
      provider = excluded.provider,
      scope = excluded.scope,
      description = coalesce(excluded.description, secrets.description),
      updated_at = now()
    returning *
  `) as SecretRow[];

  return {
    secret: mapSecret(rows[0] as SecretRow),
    status: resolves(args.name) ? 'resolved' : 'unresolved',
  };
}

/**
 * Re-register metadata and bump the rotation timestamp. Values are never touched: the
 * operator rotates the value where it lives (environment / secret manager).
 */
export async function rotateSecret(
  sql: SQL,
  args: RegisterSecretArgs,
  options: RegisterSecretOptions = {},
): Promise<RegisteredSecret> {
  assertNoValue(args);
  const resolves = options.resolves ?? envSecretResolver();

  const rows = (await sql`
    update secrets set
      provider = ${args.provider ?? 'env'},
      scope = ${args.scope ?? 'factory'},
      description = coalesce(${args.description ?? null}, description),
      last_rotated_at = now(),
      updated_at = now()
    where name = ${args.name}
    returning *
  `) as SecretRow[];

  if (!rows[0]) {
    throw new SecretRegistryError(
      'secret_not_found',
      `secret "${args.name}" is not registered`,
      { name: args.name },
    );
  }

  return {
    secret: mapSecret(rows[0]),
    status: resolves(args.name) ? 'resolved' : 'unresolved',
  };
}

export async function listSecrets(
  sql: SQL,
  options: RegisterSecretOptions = {},
): Promise<Array<RegisteredSecret>> {
  const resolves = options.resolves ?? envSecretResolver();
  const rows = (await sql`select * from secrets order by name asc`) as SecretRow[];
  return rows.map((row) => ({
    secret: mapSecret(row),
    status: resolves(row.name) ? 'resolved' : 'unresolved',
  }));
}

export async function getSecret(
  sql: SQL,
  name: string,
  options: RegisterSecretOptions = {},
): Promise<RegisteredSecret | null> {
  const resolves = options.resolves ?? envSecretResolver();
  const rows = (await sql`select * from secrets where name = ${name} limit 1`) as SecretRow[];
  if (!rows[0]) return null;
  return {
    secret: mapSecret(rows[0]),
    status: resolves(name) ? 'resolved' : 'unresolved',
  };
}

export interface DeleteSecretOptions {
  /** References found in the definitions (git is the source of truth). */
  references?: SecretReference[];
}

/**
 * Deletes a registered secret. Refused with `secret_in_use` while any definition still
 * references the name — the caller supplies the references it found in git.
 */
export async function deleteSecret(
  sql: SQL,
  name: string,
  options: DeleteSecretOptions = {},
): Promise<boolean> {
  const inUse = (options.references ?? []).filter((reference) => reference.name === name);
  if (inUse.length > 0) {
    throw new SecretRegistryError(
      'secret_in_use',
      `secret "${name}" is referenced by ${inUse.length} definition resource(s); remove those references first`,
      {
        name,
        references: inUse.map((reference) => ({
          kind: reference.kind,
          resource: reference.resource,
          pointer: reference.pointer,
        })),
      },
    );
  }

  const rows = (await sql`delete from secrets where name = ${name} returning name`) as {
    name: string;
  }[];
  if (rows.length > 0) {
    // Usage history belongs to the name; it goes with it.
    await sql`delete from secret_usage where secret_name = ${name}`;
    await sql`delete from run_secrets where secret_name = ${name}`;
  }
  return rows.length > 0;
}

export async function getSecretUsage(
  sql: SQL,
  name: string,
): Promise<{ usage: SecretUsageRecord | null; runs: SecretUsageEntry[] }> {
  const usageRows = (await sql`
    select * from secret_usage where secret_name = ${name} limit 1
  `) as UsageRow[];

  const runRows = (await sql`
    select run_id, resolved, recorded_at from run_secrets
    where secret_name = ${name}
    order by recorded_at desc
    limit 20
  `) as { run_id: string; resolved: boolean; recorded_at: unknown }[];

  return {
    usage: usageRows[0] ? mapUsage(usageRows[0]) : null,
    runs: runRows.map((row) => ({
      runId: row.run_id,
      resolved: row.resolved,
      recordedAt: iso(row.recorded_at),
    })),
  };
}

/** Every usage row — the Secrets page joins it in one query. */
export async function listSecretUsage(sql: SQL): Promise<SecretUsageRecord[]> {
  const rows = (await sql`select * from secret_usage order by secret_name asc`) as UsageRow[];
  return rows.map(mapUsage);
}

export interface RunSecretEntry {
  name: string;
  resolved: boolean;
}/**
 * Records the secret *names* a run resolved (spec `secrets` › usage audit).
 *
 * Idempotent per `(runId, name)`: a retried lease does not inflate the use count. Only
 * names that actually resolved increment usage; an unresolved name is still recorded so
 * the UI can show why a run will fail.
 */
export async function recordRunSecrets(
  sql: SQL,
  args: { runId: string; secrets: ReadonlyArray<RunSecretEntry> },
): Promise<{ recorded: string[] }> {
  const recorded: string[] = [];
  for (const secret of args.secrets) {
    const rows = (await sql`
      insert into run_secrets (run_id, secret_name, resolved)
      values (${args.runId}, ${secret.name}, ${secret.resolved})
      on conflict (run_id, secret_name) do nothing
      returning secret_name
    `) as { secret_name: string }[];
    if (rows.length === 0) continue;
    recorded.push(secret.name);

    if (!secret.resolved) continue;
    await sql`
      insert into secret_usage (secret_name, use_count, last_run_id, last_used_at)
      values (${secret.name}, 1, ${args.runId}, now())
      on conflict (secret_name) do update set
        use_count = secret_usage.use_count + 1,
        last_run_id = excluded.last_run_id,
        last_used_at = excluded.last_used_at
    `;
  }
  return { recorded };
}

/* ------------------------------------------------------------------ MCP registry */

export type McpServerStatus = 'untested' | 'healthy' | 'unhealthy';

export interface McpServerRecord {
  factory: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  /** Environment key -> secret name. */
  env: Record<string, string>;
  url: string | null;
  /** Header name -> secret name. */
  headers: Record<string, string>;
  status: McpServerStatus;
  updatedAt: string | null;
}

export interface McpBindingRecord {
  factory: string;
  agent: string;
  server: string;
  toolsAllow: string[];
  toolsDeny: string[];
  updatedAt: string | null;
}

export interface McpTestRecord {
  id: number;
  factory: string;
  server: string;
  transport: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
  runnerId: string | null;
  createdAt: string | null;
}

interface McpServerRow {
  factory: string;
  name: string;
  transport: string;
  command: string | null;
  args: unknown;
  env: unknown;
  url: string | null;
  headers: unknown;
  status: string;
  updated_at: unknown;
}

interface McpBindingRow {
  factory: string;
  agent: string;
  server: string;
  tools_allow: unknown;
  tools_deny: unknown;
  updated_at: unknown;
}

interface McpTestRow {
  id: number | string;
  factory: string;
  server: string;
  transport: string;
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
  runner_id: string | null;
  created_at: unknown;
}

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function mapServer(row: McpServerRow): McpServerRecord {
  return {
    factory: row.factory,
    name: row.name,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    command: row.command,
    args: parseJsonb<string[]>(row.args, []),
    env: parseJsonb<Record<string, string>>(row.env, {}),
    url: row.url,
    headers: parseJsonb<Record<string, string>>(row.headers, {}),
    status: (row.status as McpServerStatus) ?? 'untested',
    updatedAt: iso(row.updated_at),
  };
}

function mapBinding(row: McpBindingRow): McpBindingRecord {
  return {
    factory: row.factory,
    agent: row.agent,
    server: row.server,
    toolsAllow: parseJsonb<string[]>(row.tools_allow, []),
    toolsDeny: parseJsonb<string[]>(row.tools_deny, []),
    updatedAt: iso(row.updated_at),
  };
}

function mapTest(row: McpTestRow): McpTestRecord {
  return {
    id: Number(row.id),
    factory: row.factory,
    server: row.server,
    transport: row.transport,
    ok: row.ok,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    error: row.error,
    runnerId: row.runner_id,
    createdAt: iso(row.created_at),
  };
}

export interface UpsertMcpServerArgs {
  factory: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
  status?: McpServerStatus;
}

export async function upsertMcpServer(sql: SQL, args: UpsertMcpServerArgs): Promise<McpServerRecord> {
  const rows = (await sql`
    insert into mcp_servers (
      factory, name, transport, command, args, env, url, headers, status, updated_at
    ) values (
      ${args.factory}, ${args.name}, ${args.transport}, ${args.command ?? null},
      ${(args.args ?? [])}::jsonb, ${(args.env ?? {})}::jsonb, ${args.url ?? null},
      ${(args.headers ?? {})}::jsonb, ${args.status ?? 'untested'}, now()
    )
    on conflict (factory, name) do update set
      transport = excluded.transport,
      command = excluded.command,
      args = excluded.args,
      env = excluded.env,
      url = excluded.url,
      headers = excluded.headers,
      status = case
        when excluded.status = 'untested' then mcp_servers.status
        else excluded.status
      end,
      updated_at = now()
    returning *
  `) as McpServerRow[];
  return mapServer(rows[0] as McpServerRow);
}

export async function listMcpServers(sql: SQL, factory: string): Promise<McpServerRecord[]> {
  const rows = (await sql`
    select * from mcp_servers where factory = ${factory} order by name asc
  `) as McpServerRow[];
  return rows.map(mapServer);
}

export async function getMcpServer(
  sql: SQL,
  factory: string,
  name: string,
): Promise<McpServerRecord | null> {
  const rows = (await sql`
    select * from mcp_servers where factory = ${factory} and name = ${name} limit 1
  `) as McpServerRow[];
  return rows[0] ? mapServer(rows[0]) : null;
}

export interface UpsertMcpBindingArgs {
  factory: string;
  agent: string;
  server: string;
  toolsAllow?: string[];
  toolsDeny?: string[];
}

export async function upsertMcpBinding(
  sql: SQL,
  args: UpsertMcpBindingArgs,
): Promise<McpBindingRecord> {
  const rows = (await sql`
    insert into mcp_bindings (factory, agent, server, tools_allow, tools_deny, updated_at)
    values (
      ${args.factory}, ${args.agent}, ${args.server},
      ${(args.toolsAllow ?? [])}::jsonb, ${(args.toolsDeny ?? [])}::jsonb, now()
    )
    on conflict (factory, agent, server) do update set
      tools_allow = excluded.tools_allow,
      tools_deny = excluded.tools_deny,
      updated_at = now()
    returning *
  `) as McpBindingRow[];
  return mapBinding(rows[0] as McpBindingRow);
}

export async function listMcpBindings(sql: SQL, factory: string): Promise<McpBindingRecord[]> {
  const rows = (await sql`
    select * from mcp_bindings where factory = ${factory} order by agent asc, server asc
  `) as McpBindingRow[];
  return rows.map(mapBinding);
}

/** Replaces the registry projection for a factory with exactly these servers/bindings. */
export async function replaceMcpRegistry(
  sql: SQL,
  args: {
    factory: string;
    servers: ReadonlyArray<UpsertMcpServerArgs>;
    bindings: ReadonlyArray<UpsertMcpBindingArgs>;
  },
): Promise<void> {
  for (const server of args.servers) await upsertMcpServer(sql, server);
  await sql`delete from mcp_bindings where factory = ${args.factory}`;
  for (const binding of args.bindings) await upsertMcpBinding(sql, binding);
}

export interface RecordMcpTestArgs {
  factory: string;
  server: string;
  transport: string;
  ok: boolean;
  latencyMs?: number | null;
  error?: string | null;
  runnerId?: string | null;
}

/** Records a probe result and flips the server status (spec: `unhealthy` on failure). */
export async function recordMcpTest(sql: SQL, args: RecordMcpTestArgs): Promise<McpTestRecord> {
  const rows = (await sql`
    insert into mcp_tests (factory, server, transport, ok, latency_ms, error, runner_id)
    values (
      ${args.factory}, ${args.server}, ${args.transport}, ${args.ok},
      ${args.latencyMs ?? null}, ${args.error ?? null}, ${args.runnerId ?? null}
    )
    returning *
  `) as McpTestRow[];

  await sql`
    update mcp_servers set status = ${args.ok ? 'healthy' : 'unhealthy'}, updated_at = now()
    where factory = ${args.factory} and name = ${args.server}
  `;

  return mapTest(rows[0] as McpTestRow);
}

export async function latestMcpTest(
  sql: SQL,
  factory: string,
  server: string,
): Promise<McpTestRecord | null> {
  const rows = (await sql`
    select * from mcp_tests
    where factory = ${factory} and server = ${server}
    order by created_at desc, id desc
    limit 1
  `) as McpTestRow[];
  return rows[0] ? mapTest(rows[0]) : null;
}

export async function listMcpTests(sql: SQL, factory: string): Promise<McpTestRecord[]> {
  const rows = (await sql`
    select * from mcp_tests where factory = ${factory} order by created_at desc, id desc limit 100
  `) as McpTestRow[];
  return rows.map(mapTest);
}
