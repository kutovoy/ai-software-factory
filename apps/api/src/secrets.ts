import { z } from 'zod';
import {
  SECRET_PROVIDERS,
  SECRET_SCOPES,
  SecretRegistryError,
  collectSecretReferences,
  deleteSecret,
  getSecret,
  getSecretUsage,
  listSecretUsage,
  listSecrets,
  loadDefinition,
  registerSecret,
  rotateSecret,
  type AgentDef,
  type RegisteredSecret,
  type SecretReference,
  type SecretStatus,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError, invalidRequest } from './errors';
import { listFactories, resolveFactoryDir } from './factories';

/**
 * Secret resolution (ADR-023): definitions and integrations reference secrets by **name**;
 * the value is resolved from the process environment at call time and never returned by an
 * API projection or written to an event/log.
 */

export function resolveSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ref] ?? env[ref.toUpperCase()] ?? env[`SECRET_${ref.toUpperCase()}`];
}

export function isSecretConfigured(ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = resolveSecret(ref, env);
  return typeof value === 'string' && value.length > 0;
}

/**
 * Rejects anything that looks like a literal credential: a secret *reference* is a name,
 * never a value (spec: secret by reference).
 */
export function looksLikeSecretValue(value: string): boolean {
  return (
    /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}$/.test(value) ||
    /^github_pat_[A-Za-z0-9_]{10,}$/.test(value) ||
    /^[A-Za-z0-9+/=]{40,}$/.test(value) ||
    /\s/.test(value)
  );
}

/* ==================================================================== */
/* Registry (spec `secrets`)                                            */
/* ==================================================================== */

const secretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'secret name must match [A-Za-z_][A-Za-z0-9_]*');

export const registerSecretBodySchema = z
  .object({
    name: secretNameSchema,
    provider: z.enum(SECRET_PROVIDERS).optional(),
    scope: z.enum(SECRET_SCOPES).optional(),
    description: z.string().max(500).optional(),
    /**
     * Explicitly accepted so the rejection is a stable code (`secret_value_rejected`)
     * rather than a generic schema failure. The value is never stored.
     */
    value: z.unknown().optional(),
  })
  .strict();

export type RegisterSecretBody = z.infer<typeof registerSecretBodySchema>;

export const rotateSecretBodySchema = z
  .object({
    provider: z.enum(SECRET_PROVIDERS).optional(),
    scope: z.enum(SECRET_SCOPES).optional(),
    description: z.string().max(500).optional(),
    value: z.unknown().optional(),
  })
  .strict();

export type RotateSecretBody = z.infer<typeof rotateSecretBodySchema>;

export interface SecretView {
  name: string;
  provider: string;
  scope: string;
  description: string | null;
  /** `resolved` when the name currently resolves in the runtime environment. */
  status: SecretStatus;
  lastRotatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  useCount: number;
  lastRunId: string | null;
  lastUsedAt: string | null;
}

/** A name a definition references but the registry does not know (spec: `secret_unregistered`). */
export interface UnregisteredSecretView {
  name: string;
  references: SecretReference[];
}

function toView(registered: RegisteredSecret): SecretView {
  return {
    ...registered.secret,
    status: registered.status,
    useCount: 0,
    lastRunId: null,
    lastUsedAt: null,
  };
}

function registryError(error: unknown): never {
  if (error instanceof SecretRegistryError) {
    const status =
      error.code === 'secret_not_found' ? 404 : error.code === 'secret_in_use' ? 409 : 400;
    throw new ApiError(error.code, status, error.message, error.details);
  }
  throw error;
}

/** Every secret reference found in every definition (git is the source of truth). */
export function collectAllSecretReferences(config: ApiConfig): SecretReference[] {
  const references: SecretReference[] = [];
  let factories: string[];
  try {
    factories = listFactories(config).map((factory) => factory.name);
  } catch {
    return references;
  }

  for (const factory of factories) {
    try {
      const dir = resolveFactoryDir(config, factory);
      const { definition } = loadDefinition(dir);
      if (!definition) continue;
      const agents = definition.resources
        .filter((resource) => resource.kind === 'agent')
        .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
      // Attribute every reference to its factory directory (path-is-identity): the same
      // name at the same pointer in two factories must not collapse into one row.
      references.push(
        ...collectSecretReferences(definition.manifest, agents).map((reference) => ({
          ...reference,
          factory,
        })),
      );
    } catch {
      // An unreadable definition cannot reference anything this process can see.
    }
  }
  return references;
}

export async function listSecretsForApi(
  config: ApiConfig,
): Promise<{ secrets: SecretView[]; unregistered: UnregisteredSecretView[] }> {
  const sql = getSql();
  const [registered, usage] = await Promise.all([
    listSecrets(sql, { resolves: isSecretConfigured }),
    listSecretUsage(sql),
  ]);

  const byName = new Map(usage.map((row) => [row.secretName, row]));
  const secrets = registered.map((entry) => {
    const view = toView(entry);
    const row = byName.get(entry.secret.name);
    if (row) {
      view.useCount = row.useCount;
      view.lastRunId = row.lastRunId;
      view.lastUsedAt = row.lastUsedAt;
    }
    return view;
  });

  // Referenced-but-unregistered names: the definition validation warning, surfaced where
  // the operator can act on it (spec `secrets` › definition validation).
  const known = new Set(registered.map((entry) => entry.secret.name));
  const missing = new Map<string, UnregisteredSecretView>();
  for (const reference of collectAllSecretReferences(config)) {
    if (known.has(reference.name)) continue;
    const entry = missing.get(reference.name) ?? { name: reference.name, references: [] };
    entry.references.push(reference);
    missing.set(reference.name, entry);
  }

  return {
    secrets,
    unregistered: [...missing.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function registerSecretForApi(
  config: ApiConfig,
  body: RegisterSecretBody,
): Promise<{ secret: SecretView }> {
  void config;
  try {
    const registered = await registerSecret(
      getSql(),
      {
        name: body.name,
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.value === undefined ? {} : { value: body.value }),
      },
      { resolves: isSecretConfigured },
    );
    return { secret: toView(registered) };
  } catch (error) {
    registryError(error);
  }
}

export async function rotateSecretForApi(
  config: ApiConfig,
  name: string,
  body: RotateSecretBody,
): Promise<{ secret: SecretView }> {
  void config;
  try {
    const registered = await rotateSecret(
      getSql(),
      {
        name,
        ...(body.provider ? { provider: body.provider } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.value === undefined ? {} : { value: body.value }),
      },
      { resolves: isSecretConfigured },
    );
    return { secret: toView(registered) };
  } catch (error) {
    registryError(error);
  }
}

export async function deleteSecretForApi(
  config: ApiConfig,
  name: string,
): Promise<{ name: string; deleted: boolean; references: SecretReference[] }> {
  const references = collectAllSecretReferences(config).filter(
    (reference) => reference.name === name,
  );
  try {
    const deleted = await deleteSecret(getSql(), name, { references });
    if (!deleted) {
      throw new ApiError('secret_not_found', 404, `secret "${name}" is not registered`, { name });
    }
    return { name, deleted: true, references: [] };
  } catch (error) {
    registryError(error);
  }
}

export interface SecretUsageView {
  name: string;
  registered: boolean;
  status: SecretStatus;
  useCount: number;
  lastRunId: string | null;
  lastUsedAt: string | null;
  runs: { runId: string; resolved: boolean; recordedAt: string | null }[];
  /** Definitions that still reference the name (why it cannot be deleted). */
  references: SecretReference[];
}

export async function getSecretUsageForApi(
  config: ApiConfig,
  name: string,
): Promise<SecretUsageView> {
  const sql = getSql();
  const [registered, usage] = await Promise.all([
    getSecret(sql, name, { resolves: isSecretConfigured }),
    getSecretUsage(sql, name),
  ]);
  const references = collectAllSecretReferences(config).filter(
    (reference) => reference.name === name,
  );

  if (!registered && !usage.usage && usage.runs.length === 0 && references.length === 0) {
    throw new ApiError('secret_not_found', 404, `secret "${name}" is not registered`, { name });
  }

  return {
    name,
    registered: registered !== null,
    status: registered?.status ?? 'unresolved',
    useCount: usage.usage?.useCount ?? 0,
    lastRunId: usage.usage?.lastRunId ?? null,
    lastUsedAt: usage.usage?.lastUsedAt ?? null,
    runs: usage.runs,
    references,
  };
}

/** `GET /secrets/:name/usage` accepts any valid secret name. */
export function assertSecretName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw invalidRequest(`invalid secret name "${name}"`, { name });
  }
}
