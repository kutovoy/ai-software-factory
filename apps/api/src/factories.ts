import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import {
  contentHash,
  createVersion,
  diffDefinitions,
  loadDefinition,
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
import type { ApiConfig } from './config';
import { ApiError, definitionInvalid, factoryNotFound, invalidRequest } from './errors';

/**
 * Read-only projections of the git-backed factory definitions (spec `web-console`:
 * "Factory pages are read-only projections"). Nothing here writes to a definition.
 *
 * Path-is-identity: the factory key is the directory name under `FACTORY_ROOT`, so
 * `factories/example-lights-off` is addressed as `example-lights-off`; its manifest name
 * matches the directory, and its alias is the display label.
 */

const FACTORY_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const TAG_RE = /^factory-v(\d+)$/;

export interface FactoryVersionSummary {
  commit: string;
  shortCommit: string;
  tag: string | null;
  contentHash: string | null;
  dirty: boolean | null;
}

export interface FactoryListItem {
  name: string;
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
  name: string;
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

function assertFactoryName(factory: string): void {
  if (!FACTORY_NAME_RE.test(factory)) {
    throw invalidRequest(`invalid factory name "${factory}"`, { factory });
  }
}

/** Absolute directory of a factory, or `factory_not_found`. */
export function resolveFactoryDir(config: ApiConfig, factory: string): string {
  assertFactoryName(factory);
  const dir = join(config.factoryRoot, factory);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw factoryNotFound(factory);
  return dir;
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

function loadOrThrow(dir: string, factory: string): FactoryDefinition {
  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw definitionInvalid(factory, errors);
  return definition;
}

/* ------------------------------------------------------------------- list */

export function listFactories(config: ApiConfig): FactoryListItem[] {
  if (!existsSync(config.factoryRoot)) return [];

  const names = readdirSync(config.factoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => FACTORY_NAME_RE.test(name))
    .sort();

  return names.map((name) => {
    const dir = join(config.factoryRoot, name);
    const { definition, errors } = loadDefinition(dir);
    const manifest = definition?.manifest ?? null;
    return {
      name,
      manifestName: manifest?.name ?? null,
      alias: manifest?.alias ?? null,
      description: manifest?.description ?? null,
      repoCount: manifest?.repositories.length ?? 0,
      resourceCount: definition?.resources.length ?? 0,
      valid: definition !== null,
      errorCount: errors.length,
      version: factoryVersion(dir),
    };
  });
}

/* ----------------------------------------------------------------- detail */

export function getFactory(config: ApiConfig, factory: string): FactoryDetail {
  const dir = resolveFactoryDir(config, factory);
  const definition = loadOrThrow(dir, factory);
  const gates = resolveAllGates(definition.manifest);
  const declaredDefault =
    definition.manifest.agentDefaults.harness?.model ?? definition.manifest.agentDefaults.model;

  return {
    name: factory,
    manifest: definition.manifest,
    manifestName: definition.manifest.name,
    alias: definition.manifest.alias ?? null,
    description: definition.manifest.description ?? null,
    repoCount: definition.manifest.repositories.length,
    resourceCount: definition.resources.length,
    version: factoryVersion(dir),
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
  const definition = loadOrThrow(dir, factory);

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
