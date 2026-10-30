import type { SQL } from 'bun';

/**
 * Integration registry (Phase 3b). A connection is stored by **secret reference** only:
 * `secret_ref` is a name resolved at run time, never a token (ADR-023).
 */

export const INTEGRATION_PROVIDERS = ['github', 'gitlab', 'webhook'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface IntegrationRepoRef {
  owner: string;
  name: string;
}

export interface IntegrationRecord {
  id: string;
  factory: string;
  provider: IntegrationProvider;
  /** Secret *name* holding the token (e.g. `GITHUB_TOKEN`). */
  secretRef: string;
  /** Secret *name* holding the webhook HMAC key. */
  webhookSecretRef: string | null;
  repos: IntegrationRepoRef[];
  config: Record<string, unknown>;
  dryRun: boolean;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface IntegrationRow {
  id: string;
  factory: string;
  provider: string;
  secret_ref: string;
  webhook_secret_ref: string | null;
  repos: unknown;
  config: unknown;
  dry_run: boolean;
  enabled: boolean;
  created_at: unknown;
  updated_at: unknown;
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

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function map(row: IntegrationRow): IntegrationRecord {
  return {
    id: row.id,
    factory: row.factory,
    provider: row.provider as IntegrationProvider,
    secretRef: row.secret_ref,
    webhookSecretRef: row.webhook_secret_ref,
    repos: parseJsonb<IntegrationRepoRef[]>(row.repos, []),
    config: parseJsonb<Record<string, unknown>>(row.config, {}),
    dryRun: row.dry_run,
    enabled: row.enabled,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function integrationId(factory: string, provider: IntegrationProvider): string {
  return `${provider}:${factory}`;
}

export interface UpsertIntegrationArgs {
  factory: string;
  provider: IntegrationProvider;
  secretRef: string;
  webhookSecretRef?: string | null;
  repos?: IntegrationRepoRef[];
  config?: Record<string, unknown>;
  dryRun?: boolean;
  enabled?: boolean;
}

export async function upsertIntegration(
  sql: SQL,
  args: UpsertIntegrationArgs,
): Promise<IntegrationRecord> {
  const rows = (await sql`
    insert into integrations (
      id, factory, provider, secret_ref, webhook_secret_ref, repos, config, dry_run,
      enabled, updated_at
    ) values (
      ${integrationId(args.factory, args.provider)}, ${args.factory}, ${args.provider},
      ${args.secretRef}, ${args.webhookSecretRef ?? null},
      ${(args.repos ?? [])}::jsonb, ${(args.config ?? {})}::jsonb,
      ${args.dryRun ?? false}, ${args.enabled ?? true}, now()
    )
    on conflict (factory, provider) do update set
      secret_ref = excluded.secret_ref,
      webhook_secret_ref = excluded.webhook_secret_ref,
      repos = excluded.repos,
      config = excluded.config,
      dry_run = excluded.dry_run,
      enabled = excluded.enabled,
      updated_at = now()
    returning *
  `) as IntegrationRow[];
  return map(rows[0] as IntegrationRow);
}

export async function getIntegration(
  sql: SQL,
  factory: string,
  provider: IntegrationProvider,
): Promise<IntegrationRecord | null> {
  const rows = (await sql`
    select * from integrations where factory = ${factory} and provider = ${provider} limit 1
  `) as IntegrationRow[];
  return rows[0] ? map(rows[0]) : null;
}

export async function listIntegrations(sql: SQL, factory: string): Promise<IntegrationRecord[]> {
  const rows = (await sql`
    select * from integrations where factory = ${factory} order by provider asc
  `) as IntegrationRow[];
  return rows.map(map);
}

/** Every enabled connection for a provider (webhook routing: repo → factory). */
export async function listEnabledIntegrations(
  sql: SQL,
  provider: IntegrationProvider,
): Promise<IntegrationRecord[]> {
  const rows = (await sql`
    select * from integrations where provider = ${provider} and enabled = true
  `) as IntegrationRow[];
  return rows.map(map);
}
