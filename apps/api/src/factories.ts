import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  FACTORY_ID_RE,
  contentHash,
  createVersion,
  createVersionAsync,
  diffDefinitions,
  loadDefinition,
  readFactoryId,
  renderDiffText,
  resolveAllGates,
  resolveModelRef,
  type DefinitionDiff,
  type FactoryDefinition,
  type FactoryManifest,
  type GateResolution,
  type Resource,
  type ResourceKind,
  type ValidationError,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { canAccessFactory, ownerFilter, type Viewer } from './auth';
import { ApiError, definitionInvalid, factoryNotFound, invalidRequest } from './errors';
import { log } from './logger';

/**
 * Read-only projections of the git-backed factory definitions (spec `web-console`:
 * "Factory pages are read-only projections"). Nothing here writes to a definition.
 *
 * Identity (change `add-factory-identity`, spec `factory-identity`):
 *  - a factory has a committed `fac_<ulid>` id in `factory.yaml`; URLs and the API use only
 *    that id, never a directory name;
 *  - the **internal key** is the definition path below `FACTORY_ROOT`: the legacy top-level
 *    directory name (`example`) or an owner-scoped path (`alice/hello-nextjs`). Existing
 *    tables keep `factory` text = key, so historical rows keep working;
 *  - the `factories` registry maps id → owner, name, path and key. It is derived from git
 *    and re-synced on every list/resolve; a failed sync (no database yet) degrades to a
 *    filesystem-only projection instead of failing the request.
 */

const FACTORY_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TAG_RE = /^factory-v(\d+)$/;

/** Longest allowed key: `owner/name`. */
const MAX_KEY_SEGMENTS = 2;

export interface FactoryVersionSummary {
  commit: string;
  shortCommit: string;
  tag: string | null;
  contentHash: string | null;
  dirty: boolean | null;
}

export interface FactoryListItem {
  /** Stable `fac_<ulid>` identity — the only value a URL may carry. */
  id: string | null;
  /** Internal key: `<name>` (legacy) or `<owner>/<name>`. */
  key: string;
  /** Local directory name (the part after the owner, if any). */
  name: string;
  /** Definition path relative to `FACTORY_ROOT` (equal to `key`). */
  path: string;
  /** Console username of the owner, or null for a pre-auth/admin-less deployment. */
  owner: string | null;
  manifestName: string | null;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  valid: boolean;
  errorCount: number;
  version: FactoryVersionSummary | null;
}

export interface FactoryDetail {
  /** Stable `fac_<ulid>` identity. */
  id: string | null;
  /** Internal key (definition path below `FACTORY_ROOT`). */
  name: string;
  key: string;
  manifest: FactoryManifest;
  manifestName: string;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  version: FactoryVersionSummary | null;
  gates: GateResolution;
  fullyAutonomous: boolean;
  benchmarkGateRequired: boolean;
  /**
   * The factory's default model, resolved from `env:` if needed (ADR-028). `null` when
   * the default is an unset reference; clients must not render the literal `env:...`.
   */
  defaultModel: string | null;
}

export interface ResourceSummary {
  kind: ResourceKind;
  name: string;
  path: string;
  format: 'yaml' | 'markdown';
  summary: string;
  /**
   * Normalised document (schema defaults applied). Read-only projection of what git
   * declares; secret *names* only, never values (there are none in a definition).
   */
  doc: unknown;
}

export interface FactoryResources {
  factory: string;
  counts: Record<string, number>;
  resources: ResourceSummary[];
}

export interface FactoryVersionEntry {
  commit: string;
  shortCommit: string;
  tag: string | null;
  date: string | null;
  message: string;
}

export interface FactoryDiff {
  factory: string;
  from: { commit: string | null; tag: string | null };
  to: { commit: string; tag: string | null };
  diff: DefinitionDiff;
  text: string;
}

/** A factory as found on disk plus its registry identity. */
export interface FactoryRecord {
  id: string | null;
  key: string;
  path: string;
  /** Local directory name (last path segment). */
  name: string;
  dir: string;
  legacy: boolean;
  ownerUsername: string | null;
  ownerId: string | null;
  manifestName: string | null;
  alias: string | null;
  description: string | null;
  repoCount: number;
  resourceCount: number;
  valid: boolean;
  errorCount: number;
  version: FactoryVersionSummary | null;
}

/** A definition directory found under `FACTORY_ROOT`. */
export interface FactoryPathEntry {
  key: string;
  path: string;
  name: string;
  dir: string;
  legacy: boolean;
  ownerUsername: string | null;
}

interface RegistryUser {
  id: string;
  username: string;
  role: string;
}

/**
 * A row of the derived `factories` registry. It mirrors what `syncFactoryRegistry`
 * observed on disk, so a read path can answer from one indexed SQL query instead of
 * re-scanning every definition directory.
 */
interface FactoryRegistryRow {
  id: string;
  owner_id: string | null;
  name: string;
  key: string;
  path: string;
  alias: string | null;
  manifest_name: string | null;
  description: string | null;
  definition_commit: string | null;
  content_hash: string | null;
  dirty: boolean | null;
  tag: string | null;
  resource_count: number | string | null;
  repo_count: number | string | null;
  valid: boolean | null;
  error_count: number | string | null;
  synced_at: unknown;
  owner_username: string | null;
}

function recordFromRegistry(row: FactoryRegistryRow): FactoryRecord {
  const commit = row.definition_commit;
  return {
    id: row.id,
    key: row.key,
    path: row.path,
    name: row.name,
    dir: '', // only needed by filesystem projections; registry reads never touch it
    legacy: !row.key.includes('/'),
    ownerUsername: row.owner_username,
    ownerId: row.owner_id,
    manifestName: row.manifest_name,
    alias: row.alias,
    description: row.description,
    repoCount: Number(row.repo_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    valid: row.valid === true,
    errorCount: Number(row.error_count ?? 0),
    version: commit
      ? {
          commit,
          shortCommit: shortCommit(commit),
          tag: row.tag,
          contentHash: row.content_hash,
          dirty: row.dirty,
        }
      : null,
  };
}

function listItemFromRecord(record: FactoryRecord): FactoryListItem {
  return {
    id: record.id,
    key: record.key,
    name: record.name,
    path: record.path,
    owner: record.ownerUsername,
    manifestName: record.manifestName,
    alias: record.alias,
    description: record.description,
    repoCount: record.repoCount,
    resourceCount: record.resourceCount,
    valid: record.valid,
    errorCount: record.errorCount,
    version: record.version,
  };
}

/** Rejects a key that is not `name` or `owner/name` before touching the filesystem. */
export function assertFactoryKey(factory: string): void {
  const segments = factory.split('/');
  if (
    segments.length === 0 ||
    segments.length > MAX_KEY_SEGMENTS ||
    segments.some((segment) => !FACTORY_NAME_RE.test(segment))
  ) {
    throw invalidRequest(`invalid factory key "${factory}"`, { factory });
  }
}

/** Absolute directory of a factory key, or `factory_not_found`. */
export function resolveFactoryDir(config: ApiConfig, factory: string): string {
  assertFactoryKey(factory);
  const dir = join(config.factoryRoot, ...factory.split('/'));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw factoryNotFound(factory);
  return dir;
}

/**
 * Every definition directory below `FACTORY_ROOT`:
 *  - legacy top-level `factories/<name>` (admin-owned, key `<name>`);
 *  - owner-scoped `factories/<owner>/<name>` (key `<owner>/<name>`).
 *
 * A directory only counts when it holds `factory.yaml`, so `agents/`, `benchmarks/` and the
 * other resource folders of a legacy factory are never mistaken for owners.
 */
export function scanFactoryPaths(config: ApiConfig): FactoryPathEntry[] {
  if (!existsSync(config.factoryRoot)) return [];

  const entries = readdirSync(config.factoryRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && FACTORY_NAME_RE.test(entry.name),
  );

  const found: FactoryPathEntry[] = [];
  for (const entry of entries) {
    const dir = join(config.factoryRoot, entry.name);
    if (existsSync(join(dir, 'factory.yaml'))) {
      found.push({
        key: entry.name,
        path: entry.name,
        name: entry.name,
        dir,
        legacy: true,
        ownerUsername: null,
      });
      continue;
    }

    const children = readdirSync(dir, { withFileTypes: true }).filter(
      (child) => child.isDirectory() && FACTORY_NAME_RE.test(child.name),
    );
    for (const child of children) {
      const childDir = join(dir, child.name);
      if (!existsSync(join(childDir, 'factory.yaml'))) continue;
      found.push({
        key: `${entry.name}/${child.name}`,
        path: `${entry.name}/${child.name}`,
        name: child.name,
        dir: childDir,
        legacy: false,
        ownerUsername: entry.name,
      });
    }
  }

  return found.sort((left, right) => left.key.localeCompare(right.key));
}

async function registryUsers(): Promise<RegistryUser[] | null> {
  try {
    return (await getSql()`
      select id::text as id, username, role from users order by created_at asc
    `) as RegistryUser[];
  } catch (error) {
    // The registry is a derived index; a missing database (unit tests, a fresh checkout)
    // must not make the filesystem projection unusable.
    log('warn', 'factory_registry_unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Builds a record for every definition on disk, with owner identity where known. */
async function collectFactoryRecords(config: ApiConfig): Promise<FactoryRecord[]> {
  const entries = scanFactoryPaths(config);
  const users = await registryUsers();
  const admin = users?.find((user) => user.role === 'admin') ?? null;
  const byUsername = new Map((users ?? []).map((user) => [user.username, user]));

  return await Promise.all(
    entries.map(async (entry) => {
      const { definition, errors } = loadDefinition(entry.dir, { requireFactoryId: true });
      const manifest = definition?.manifest ?? null;
      const owner = entry.legacy
        ? admin
        : entry.ownerUsername
          ? (byUsername.get(entry.ownerUsername) ?? null)
          : null;

      return {
        id: manifest?.id ?? readFactoryId(entry.dir),
        key: entry.key,
        path: entry.path,
        name: entry.name,
        dir: entry.dir,
        legacy: entry.legacy,
        ownerUsername: entry.ownerUsername,
        ownerId: owner?.id ?? null,
        manifestName: manifest?.name ?? null,
        alias: manifest?.alias ?? null,
        description: manifest?.description ?? null,
        repoCount: manifest?.repositories.length ?? 0,
        resourceCount: definition?.resources.length ?? 0,
        valid: definition !== null,
        errorCount: errors.length,
        version: await factoryVersionAsync(entry.dir, definition ?? undefined),
      };
    }),
  );
}

/** Upserts the registry rows for the definitions on disk. Best effort. */
async function upsertRegistry(records: FactoryRecord[]): Promise<void> {
  const sql = getSql();
  try {
    for (const record of records) {
      if (!record.id) continue;
      // A re-minted id (or a moved directory) must not leave a stale row behind that would
      // win the unique `key`/`path` constraint on insert.
      await sql`
        delete from factories
        where (key = ${record.key} or path = ${record.path}) and id <> ${record.id}
      `;
      await sql`
        insert into factories (
          id, owner_id, name, key, path, alias, manifest_name, description,
          definition_commit, content_hash, dirty, tag, resource_count, repo_count,
          valid, error_count, synced_at
        )
        values (
          ${record.id}, ${record.ownerId}::uuid, ${record.name}, ${record.key},
          ${record.path}, ${record.alias}, ${record.manifestName}, ${record.description},
          ${record.version?.commit ?? null}, ${record.version?.contentHash ?? null},
          ${record.version?.dirty ?? null}, ${record.version?.tag ?? null},
          ${record.resourceCount}, ${record.repoCount}, ${record.valid}, ${record.errorCount},
          now()
        )
        on conflict (id) do update set
          owner_id = excluded.owner_id,
          name = excluded.name,
          key = excluded.key,
          path = excluded.path,
          alias = excluded.alias,
          manifest_name = excluded.manifest_name,
          description = excluded.description,
          definition_commit = excluded.definition_commit,
          content_hash = excluded.content_hash,
          dirty = excluded.dirty,
          tag = excluded.tag,
          resource_count = excluded.resource_count,
          repo_count = excluded.repo_count,
          valid = excluded.valid,
          error_count = excluded.error_count,
          synced_at = excluded.synced_at,
          updated_at = now()
      `;
    }
  } catch (error) {
    log('warn', 'factory_registry_sync_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Syncs the registry from git and returns every factory on disk. Callers apply the owner
 * scope themselves (`listFactories`, `resolveFactory`).
 */
export async function syncFactoryRegistry(config: ApiConfig): Promise<FactoryRecord[]> {
  const records = await collectFactoryRecords(config);
  await upsertRegistry(records);
  return records;
}

/* -------------------------------------------------------- registry read model */

let registrySyncedAt = 0;
let registryMissSyncedAt = 0;
let registrySyncInFlight: Promise<FactoryRecord[]> | null = null;

/**
 * Single-flight sync shared by every request. A TTL keeps a filesystem/git scan out of
 * the common read path; explicit misses still force a sync so a newly committed factory
 * appears without a restart.
 */
async function syncRegistryCached(config: ApiConfig): Promise<FactoryRecord[]> {
  if (registrySyncInFlight) return registrySyncInFlight;
  registrySyncInFlight = syncFactoryRegistry(config)
    .then((records) => {
      registrySyncedAt = Date.now();
      return records;
    })
    .finally(() => {
      registrySyncInFlight = null;
    });
  return registrySyncInFlight;
}

async function ensureRegistryFresh(config: ApiConfig): Promise<FactoryRecord[] | null> {
  if (Date.now() - registrySyncedAt < config.factoryRegistryTtlMs) return null;
  return syncRegistryCached(config);
}

/** Registry rows for a viewer, optionally narrowed to one opaque factory id. */
async function registryRows(
  viewer: Viewer | null,
  factoryId?: string,
): Promise<FactoryRegistryRow[]> {
  const owner = ownerFilter(viewer);
  return (await getSql()`
    select f.*, u.username as owner_username
    from factories f
    left join users u on u.id = f.owner_id
    where (${factoryId ?? null}::text is null or f.id = ${factoryId ?? null})
      and (${owner}::uuid is null or f.owner_id = ${owner}::uuid)
    order by f.key asc
  `) as FactoryRegistryRow[];
}

/** POSIX path of the factory relative to the git root that contains `FACTORY_ROOT`. */
export function factoryRepoPath(config: ApiConfig, dir: string): string {
  const rel = relative(config.repoRoot, dir).split(sep).join('/');
  if (rel.startsWith('..') || rel === '') {
    throw new ApiError(
      'definition_not_versioned',
      422,
      'the factory directory is outside REPO_ROOT; it cannot be versioned',
      { factoryRoot: config.factoryRoot, repoRoot: config.repoRoot },
    );
  }
  return rel;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tagFor(repoRoot: string, commit: string): string | null {
  try {
    const tags = git(repoRoot, ['tag', '--points-at', commit])
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => TAG_RE.test(tag));
    if (tags.length === 0) return null;
    return tags.sort((left, right) => {
      const a = Number(TAG_RE.exec(left)?.[1] ?? 0);
      const b = Number(TAG_RE.exec(right)?.[1] ?? 0);
      return a - b;
    })[tags.length - 1] as string;
  } catch {
    return null;
  }
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

/** Version of a factory directory; `null` when the directory is not inside a git repo. */
export function factoryVersion(dir: string): FactoryVersionSummary | null {
  try {
    const version = createVersion(dir, { allowDirty: true });
    return {
      commit: version.commit,
      shortCommit: shortCommit(version.commit),
      tag: version.tag,
      contentHash: version.contentHash,
      dirty: version.dirty,
    };
  } catch {
    return null;
  }
}

/** Async version of `factoryVersion`; used by the registry sync. */
async function factoryVersionAsync(
  dir: string,
  definition?: FactoryDefinition,
): Promise<FactoryVersionSummary | null> {
  try {
    const version = await createVersionAsync(dir, { allowDirty: true }, definition);
    return {
      commit: version.commit,
      shortCommit: shortCommit(version.commit),
      tag: version.tag,
      contentHash: version.contentHash,
      dirty: version.dirty,
    };
  } catch {
    return null;
  }
}

/** The runtime loader: a definition without a `fac_<ulid>` id is `factory_id_missing`. */
export function loadFactoryDefinition(
  dir: string,
  factory: string,
): FactoryDefinition {
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);
  return definition;
}

/* ------------------------------------------------------------------- list */

export async function listFactories(
  config: ApiConfig,
  viewer: Viewer | null = null,
): Promise<FactoryListItem[]> {
  try {
    const synced = await ensureRegistryFresh(config);
    const rows = await registryRows(viewer);
    if (rows.length > 0) {
      // Rows written before the read-model migration have no `synced_at`; rebuild them
      // once rather than serving empty metadata.
      if (rows.some((row) => row.synced_at === null || row.synced_at === undefined)) {
        const records = await syncRegistryCached(config);
        return records
          .filter((record) => canAccessFactory(viewer, record))
          .map(listItemFromRecord);
      }
      return rows
        .map(recordFromRegistry)
        .filter((record) => canAccessFactory(viewer, record))
        .map(listItemFromRecord);
    }
    if (synced) {
      return synced
        .filter((record) => canAccessFactory(viewer, record))
        .map(listItemFromRecord);
    }
    return [];
  } catch (error) {
    // No database yet (unit tests, fresh checkout): keep the filesystem projection usable.
    log('warn', 'factory_registry_read_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    const records = await syncRegistryCached(config);
    return records
      .filter((record) => canAccessFactory(viewer, record))
      .map(listItemFromRecord);
  }
}

/** Registry lookup by internal key; best effort (null when the database has no row). */
export async function factoryIdForKey(key: string): Promise<string | null> {
  try {
    const rows = (await getSql()`
      select id from factories where key = ${key} limit 1
    `) as { id: string }[];
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves a factory by its opaque id for this viewer. A member only resolves factories
 * they own; anyone else gets `404 factory_not_found` — existence is never leaked (spec
 * `factory-identity` › Owner scope).
 */
export async function resolveFactory(
  config: ApiConfig,
  factoryId: string,
  viewer: Viewer | null = null,
): Promise<FactoryRecord> {
  if (!FACTORY_ID_RE.test(factoryId)) throw factoryNotFound(factoryId);

  try {
    const rows = await registryRows(viewer, factoryId);
    if (rows[0]) {
      if (rows[0].synced_at === null || rows[0].synced_at === undefined) {
        const records = await syncRegistryCached(config);
        const record = records.find((candidate) => candidate.id === factoryId);
        if (record && canAccessFactory(viewer, record)) return record;
        throw factoryNotFound(factoryId);
      }
      const record = recordFromRegistry(rows[0]);
      if (canAccessFactory(viewer, record)) return record;
      throw factoryNotFound(factoryId);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    log('warn', 'factory_registry_read_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    const records = await syncRegistryCached(config);
    const record = records.find((candidate) => candidate.id === factoryId);
    if (!record || !canAccessFactory(viewer, record)) throw factoryNotFound(factoryId);
    return record;
  }

  // A registry miss may be a factory committed after the last TTL sync. Sync at most once
  // per TTL for misses, so an unknown id cannot turn into a filesystem scan per request.
  const fresh = await ensureRegistryFresh(config);
  if (fresh) {
    const record = fresh.find((candidate) => candidate.id === factoryId);
    if (record && canAccessFactory(viewer, record)) return record;
  }
  if (Date.now() - registryMissSyncedAt >= config.factoryRegistryTtlMs) {
    registryMissSyncedAt = Date.now();
    const records = await syncRegistryCached(config);
    const record = records.find((candidate) => candidate.id === factoryId);
    if (record && canAccessFactory(viewer, record)) return record;
  }
  throw factoryNotFound(factoryId);
}

/* ----------------------------------------------------------------- detail */

interface CachedDefinition {
  at: number;
  definition: FactoryDefinition | null;
  errors: ValidationError[];
}

const DEFINITION_CACHE_TTL_MS = 30_000;
const definitionCache = new Map<string, CachedDefinition>();

function loadFactoryDefinitionCached(
  dir: string,
  factory: string,
  cacheKey: string,
): FactoryDefinition {
  const cached = definitionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DEFINITION_CACHE_TTL_MS) {
    if (!cached.definition) throw definitionInvalid(factory, cached.errors);
    return cached.definition;
  }
  const loaded = loadDefinition(dir, { requireFactoryId: true });
  if (definitionCache.size > 500) definitionCache.clear();
  definitionCache.set(cacheKey, { at: Date.now(), ...loaded });
  if (!loaded.definition) throw definitionInvalid(factory, loaded.errors);
  return loaded.definition;
}

export function getFactory(
  config: ApiConfig,
  factory: string,
  versionOverride?: FactoryVersionSummary | null,
): FactoryDetail {
  const dir = resolveFactoryDir(config, factory);
  const version = versionOverride === undefined ? factoryVersion(dir) : versionOverride;
  const definition = loadFactoryDefinitionCached(
    dir,
    factory,
    `${dir}:${version?.commit ?? 'worktree'}`,
  );
  const gates = resolveAllGates(definition.manifest);
  const declaredDefault =
    definition.manifest.agentDefaults.harness?.model ?? definition.manifest.agentDefaults.model;

  return {
    id: definition.manifest.id ?? null,
    name: factory,
    key: factory,
    manifest: definition.manifest,
    manifestName: definition.manifest.name,
    alias: definition.manifest.alias ?? null,
    description: definition.manifest.description ?? null,
    repoCount: definition.manifest.repositories.length,
    resourceCount: definition.resources.length,
    version,
    gates,
    fullyAutonomous: gates.fullyAutonomous,
    benchmarkGateRequired: gates.benchmarkGateRequired,
    defaultModel: declaredDefault ? (resolveModelRef(declaredDefault).value ?? null) : null,
  };
}

/* -------------------------------------------------------------- resources */

function firstSentence(text: string): string | null {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith('#'));
  if (!line) return null;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function summarizeResource(resource: Resource): string {
  const doc = resource.doc as Record<string, unknown>;
  const description = typeof doc.description === 'string' ? doc.description : null;
  if (description) return description;

  const role = typeof doc.role === 'string' ? doc.role : null;
  if (role) return `role: ${role}`;

  const agent = typeof doc.agent === 'string' ? doc.agent : null;
  if (agent) return `agent: ${agent}`;

  if (typeof doc.passingScore === 'number') return `passingScore: ${doc.passingScore}`;
  if (Array.isArray(doc.tasks)) return `${doc.tasks.length} tasks`;
  if (typeof doc.kind === 'string') return `runner: ${doc.kind}`;

  return firstSentence(resource.body) ?? `${resource.kind} ${resource.name}`;
}

export function getFactoryResources(config: ApiConfig, factory: string): FactoryResources {
  const dir = resolveFactoryDir(config, factory);
  const definition = loadFactoryDefinition(dir, factory);

  const counts: Record<string, number> = {};
  const resources: ResourceSummary[] = definition.resources.map((resource) => {
    counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
    return {
      kind: resource.kind,
      name: resource.name,
      path: resource.path,
      format: resource.format,
      summary: summarizeResource(resource),
      doc: resource.doc,
    };
  });

  return { factory, counts, resources };
}

/* --------------------------------------------------------------- versions */

export function getFactoryVersions(
  config: ApiConfig,
  factory: string,
  limit = 20,
): FactoryVersionEntry[] {
  const dir = resolveFactoryDir(config, factory);
  const repoPath = factoryRepoPath(config, dir);
  const capped = Math.min(Math.max(limit, 1), 100);

  let raw: string;
  try {
    raw = git(config.repoRoot, [
      'log',
      '--format=%H%x1f%aI%x1f%s',
      '-n',
      String(capped),
      '--',
      repoPath,
    ]);
  } catch {
    throw new ApiError(
      'definition_not_versioned',
      422,
      `factory "${factory}" is not inside a git repository`,
      { factory },
    );
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [commit = '', date = '', ...messageParts] = line.split('\u001f');
      return {
        commit,
        shortCommit: shortCommit(commit),
        tag: tagFor(config.repoRoot, commit),
        date: date || null,
        message: messageParts.join('\u001f'),
      };
    });
}

/* ------------------------------------------------------------------- diff */

/**
 * Loads a definition as of a git commit without touching the worktree: `git ls-tree` +
 * `git show` into a temp directory, then the normal loader. Works on a read-only repo
 * mount, which is how compose runs the API.
 */
export function loadDefinitionAtCommit(
  repoRoot: string,
  repoPath: string,
  commit: string,
): { found: boolean; definition: FactoryDefinition | null; errors: ValidationError[] } {
  let files: string[];
  try {
    files = git(repoRoot, ['ls-tree', '-r', '--name-only', commit, '--', repoPath])
      .split('\n')
      .map((file) => file.trim())
      .filter((file) => file.length > 0);
  } catch {
    return { found: false, definition: null, errors: [] };
  }
  if (files.length === 0) return { found: false, definition: null, errors: [] };

  const tmp = mkdtempSync(join(tmpdir(), 'factory-def-'));
  try {
    for (const file of files) {
      const content = execFileSync('git', ['-C', repoRoot, 'show', `${commit}:${file}`], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      const target = join(tmp, relative(repoPath, file));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
    const { definition, errors } = loadDefinition(tmp);
    return { found: true, definition, errors };
  } catch {
    return { found: false, definition: null, errors: [] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function previousCommit(repoRoot: string, repoPath: string, commit: string): string | null {
  try {
    const commits = git(repoRoot, ['rev-list', '--max-count=2', commit, '--', repoPath])
      .split('\n')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return commits.length > 1 ? (commits[1] as string) : null;
  } catch {
    return null;
  }
}

function resolveCommit(repoRoot: string, ref: string, factory: string): string {
  try {
    return git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    throw invalidRequest(`unknown git ref "${ref}"`, { factory, ref });
  }
}

export function getFactoryDiff(
  config: ApiConfig,
  factory: string,
  from?: string,
  to?: string,
): FactoryDiff {
  const dir = resolveFactoryDir(config, factory);
  const repoPath = factoryRepoPath(config, dir);

  let toCommit: string;
  try {
    toCommit = resolveCommit(config.repoRoot, to && to.length > 0 ? to : 'HEAD', factory);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('definition_not_versioned', 422, `factory "${factory}" has no git history`, {
      factory,
    });
  }

  const fromRef = from && from.length > 0 ? from : null;
  const fromCommit = fromRef
    ? resolveCommit(config.repoRoot, fromRef, factory)
    : previousCommit(config.repoRoot, repoPath, toCommit);

  const toDefinition = loadDefinitionAtCommit(config.repoRoot, repoPath, toCommit);
  if (!toDefinition.found) {
    throw new ApiError(
      'factory_not_found',
      404,
      `factory "${factory}" does not exist at commit ${shortCommit(toCommit)}`,
      { factory, commit: toCommit },
    );
  }
  if (!toDefinition.definition) {
    throw definitionInvalid(factory, toDefinition.errors);
  }

  const fromDefinition = fromCommit
    ? loadDefinitionAtCommit(config.repoRoot, repoPath, fromCommit).definition
    : null;

  const diff = fromDefinition
    ? diffDefinitions(fromDefinition, toDefinition.definition)
    : diffDefinitions(toDefinition.definition, toDefinition.definition);

  return {
    factory,
    from: { commit: fromCommit, tag: fromCommit ? tagFor(config.repoRoot, fromCommit) : null },
    to: { commit: toCommit, tag: tagFor(config.repoRoot, toCommit) },
    diff,
    text: renderDiffText(diff),
  };
}
