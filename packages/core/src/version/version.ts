import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DefinitionValidationError, validationError } from '../errors';
import { contentHash } from '../loader/hash';
import { loadDefinition, type FactoryDefinition } from '../loader/load';

export interface VersionRecord {
  factory: string;
  commit: string;
  tag: string | null;
  contentHash: string;
  dirty: boolean;
}

const TAG_RE = /^factory-v(\d+)$/;
const execFileAsync = promisify(execFile);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function gitAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * `git diff-index --quiet` exits 1 when the index differs from HEAD. That is much cheaper
 * than `git status`, which also walks the working tree. Untracked files are deliberately
 * not part of the definition version: they are not committed definition content.
 */
async function dirtyAsync(dir: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['diff-index', '--quiet', 'HEAD', '--', '.'], { cwd: dir });
    return false;
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code === 1 || code === '1') return true;
    throw error;
  }
}

function selectTag(tags: string[]): string | null {
  const factoryTags = tags
    .map((tag) => tag.trim())
    .filter((tag) => TAG_RE.test(tag))
    .sort((left, right) => {
      const a = Number(TAG_RE.exec(left)?.[1] ?? 0);
      const b = Number(TAG_RE.exec(right)?.[1] ?? 0);
      return a - b;
    });
  return factoryTags.length > 0 ? (factoryTags[factoryTags.length - 1] as string) : null;
}

/**
 * A definition version = git commit SHA + optional `factory-vN` tag + content hash.
 * Uses git plumbing only; refuses a dirty definition tree unless `allowDirty`.
 */
export function createVersion(dir: string, options: { allowDirty?: boolean } = {}): VersionRecord {
  let commit: string;
  try {
    commit = git(dir, ['rev-parse', 'HEAD']);
  } catch {
    throw new Error(`${dir} is not inside a git repository with a HEAD commit`);
  }

  const dirty = git(dir, ['status', '--porcelain', '--', '.']).length > 0;
  if (dirty && !options.allowDirty) {
    throw new DefinitionValidationError([
      validationError(
        'dirty_worktree',
        dir,
        '/',
        'definition has uncommitted changes; pass --allow-dirty to pin a dirty version',
      ),
    ]);
  }

  const { definition, errors } = loadDefinition(dir);
  if (!definition) throw new DefinitionValidationError(errors);

  const tags = git(dir, ['tag', '--points-at', 'HEAD']).split('\n');

  return {
    factory: definition.manifest.name,
    commit,
    tag: selectTag(tags),
    contentHash: contentHash(definition),
    dirty,
  };
}

/**
 * Async version of `createVersion` for request paths. It never blocks the event loop on a
 * git subprocess and can reuse a definition the caller already loaded.
 */
export async function createVersionAsync(
  dir: string,
  options: { allowDirty?: boolean } = {},
  definitionOverride?: FactoryDefinition,
): Promise<VersionRecord> {
  let commit: string;
  try {
    commit = await gitAsync(dir, ['rev-parse', 'HEAD']);
  } catch {
    throw new Error(`${dir} is not inside a git repository with a HEAD commit`);
  }

  const dirty = await dirtyAsync(dir);
  if (dirty && !options.allowDirty) {
    throw new DefinitionValidationError([
      validationError(
        'dirty_worktree',
        dir,
        '/',
        'definition has uncommitted changes; pass --allow-dirty to pin a dirty version',
      ),
    ]);
  }

  const loaded = definitionOverride
    ? { definition: definitionOverride, errors: [] }
    : loadDefinition(dir);
  const definition = loaded.definition;
  if (!definition) {
    throw new DefinitionValidationError(loaded.errors);
  }

  const tags = (await gitAsync(dir, ['tag', '--points-at', 'HEAD'])).split('\n');

  return {
    factory: definition.manifest.name,
    commit,
    tag: selectTag(tags),
    contentHash: contentHash(definition),
    dirty,
  };
}
