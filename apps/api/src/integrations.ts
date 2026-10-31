import { z } from 'zod';
import {
  getIntegration,
  listIntegrations,
  upsertIntegration,
  type IntegrationRecord,
  type IntegrationRepoRef,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { resolveFactoryDir } from './factories';
import { API_PREFIX } from './routes';
import { isSecretConfigured, looksLikeSecretValue } from './secrets';

/**
 * Integration settings (spec `code-forge` › credential by reference, `automations` › webhook
 * verification). A GitHub connection stores the token **secret name**, the webhook HMAC
 * secret name, the repositories it may act on and the trigger filters. Values never appear
 * in a projection: the API reports `configured: true/false` instead.
 */

const repoRefSchema = z
  .object({ owner: z.string().min(1).max(100), name: z.string().min(1).max(100) })
  .strict();

export const githubIntegrationBodySchema = z
  .object({
    factory: z.string().min(1),
    /** Secret *name* (e.g. `GITHUB_TOKEN`), never a value. */
    secretRef: z.string().min(1).max(120),
    webhookSecretRef: z.string().min(1).max(120).optional(),
    repos: z.array(repoRefSchema).max(50).optional(),
    /** `true` makes every mutating forge call a no-op that reports the intended action. */
    dryRun: z.boolean().optional(),
    /** ADR-022: the merge queue owns merges for this factory. */
    mergeQueue: z.boolean().optional(),
    /** GitHub events that create work (default `['issues']`). */
    events: z.array(z.string().min(1)).max(20).optional(),
    /** Labels that qualify an issue (default `['factory-ready']`). */
    labels: z.array(z.string().min(1)).max(20).optional(),
    /** Only this base branch creates work (optional). */
    branch: z.string().min(1).max(200).optional(),
    /** `all` drops bot senders (default); `none` keeps them. */
    skipBots: z.enum(['all', 'none']).optional(),
    /**
     * Harness/runner webhook-created work items run on. Unset means "whatever the factory
     * declares"; CI/compose set `fake` so deliveries are exercised without credentials.
     */
    harness: z.enum(['opencode', 'claude-code', 'codex', 'gemini', 'generic-cli', 'fake']).optional(),
    runner: z.enum(['local-docker', 'local-process', 'fake']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type GithubIntegrationBody = z.infer<typeof githubIntegrationBodySchema>;

export interface GithubIntegrationView {
  configured: boolean;
  provider: 'github';
  factory: string;
  /** Secret names only. */
  secretRef: string | null;
  webhookSecretRef: string | null;
  secretConfigured: boolean;
  webhookSecretConfigured: boolean;
  repos: IntegrationRepoRef[];
  dryRun: boolean;
  mergeQueue: boolean;
  events: string[];
  labels: string[];
  branch: string | null;
  skipBots: 'all' | 'none';
  /** Harness override for webhook-created items (`null` = the factory default). */
  harness: string | null;
  runner: string | null;
  enabled: boolean;
  /** Where the provider should POST deliveries (the console shows it verbatim). */
  webhookUrl: string;
  updatedAt: string | null;
}

export interface IntegrationsResponse {
  factory: string;
  github: GithubIntegrationView;
  others: IntegrationRecord[];
}

function webhookUrlFor(config: ApiConfig): string {
  return `${config.webhookPublicUrl.replace(/\/+$/, '')}${API_PREFIX}/webhooks/github`;
}

export function githubView(config: ApiConfig, factory: string, record: IntegrationRecord | null): GithubIntegrationView {
  const configMap = record?.config ?? {};
  return {
    configured: Boolean(record),
    provider: 'github',
    factory,
    secretRef: record?.secretRef ?? null,
    webhookSecretRef: record?.webhookSecretRef ?? config.webhookSecretRef,
    secretConfigured: record ? isSecretConfigured(record.secretRef) : false,
    webhookSecretConfigured: isSecretConfigured(record?.webhookSecretRef ?? config.webhookSecretRef),
    repos: record?.repos ?? [],
    dryRun: record?.dryRun ?? config.githubDryRun,
    mergeQueue: configMap.mergeQueue === true,
    events: Array.isArray(configMap.events) ? (configMap.events as string[]) : ['issues'],
    labels: Array.isArray(configMap.labels) ? (configMap.labels as string[]) : ['factory-ready'],
    branch: typeof configMap.branch === 'string' ? configMap.branch : null,
    skipBots: configMap.skipBots === 'none' ? 'none' : 'all',
    harness: typeof configMap.harness === 'string' ? configMap.harness : null,
    runner: typeof configMap.runner === 'string' ? configMap.runner : null,
    enabled: record?.enabled ?? false,
    webhookUrl: webhookUrlFor(config),
    updatedAt: record?.updatedAt ?? null,
  };
}

export async function getIntegrationsForApi(
  config: ApiConfig,
  factory: string,
): Promise<IntegrationsResponse> {
  resolveFactoryDir(config, factory);
  const sql = getSql();
  const [record, all] = await Promise.all([
    getIntegration(sql, factory, 'github'),
    listIntegrations(sql, factory),
  ]);
  return {
    factory,
    github: githubView(config, factory, record),
    others: all.filter((entry) => entry.provider !== 'github'),
  };
}

export async function configureGithubForApi(
  config: ApiConfig,
  body: GithubIntegrationBody,
): Promise<IntegrationsResponse> {
  resolveFactoryDir(config, body.factory);

  // A secret *reference*, not a value: reject anything that looks like a credential.
  if (looksLikeSecretValue(body.secretRef)) {
    throw invalidRequest('secretRef must be a secret name, never a token value', {
      secretRef: '***',
    });
  }
  if (body.webhookSecretRef && looksLikeSecretValue(body.webhookSecretRef)) {
    throw invalidRequest('webhookSecretRef must be a secret name, never a value', {
      webhookSecretRef: '***',
    });
  }

  const sql = getSql();
  await upsertIntegration(sql, {
    factory: body.factory,
    provider: 'github',
    secretRef: body.secretRef,
    webhookSecretRef: body.webhookSecretRef ?? config.webhookSecretRef,
    repos: body.repos ?? [],
    dryRun: body.dryRun ?? config.githubDryRun,
    enabled: body.enabled ?? true,
    config: {
      mergeQueue: body.mergeQueue ?? false,
      events: body.events ?? ['issues'],
      labels: body.labels ?? ['factory-ready'],
      ...(body.branch ? { branch: body.branch } : {}),
      skipBots: body.skipBots ?? 'all',
      ...(body.harness ? { harness: body.harness } : {}),
      ...(body.runner ? { runner: body.runner } : {}),
      githubBaseUrl: config.githubBaseUrl,
    },
  });

  return await getIntegrationsForApi(config, body.factory);
}

/** Used by the webhook router: every enabled GitHub connection, across factories. */
export async function listGithubIntegrations(): Promise<IntegrationRecord[]> {
  const { listEnabledIntegrations } = await import('@factory/core');
  return await listEnabledIntegrations(getSql(), 'github');
}

export function integrationNotFound(factory: string): ApiError {
  return new ApiError('integration_not_found', 404, `factory "${factory}" has no integration`, {
    factory,
  });
}
