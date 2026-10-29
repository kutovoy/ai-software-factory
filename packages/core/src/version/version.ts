import { execFileSync } from 'node:child_process';
import { DefinitionValidationError, validationError } from '../errors';
import { contentHash } from '../loader/hash';
import { loadDefinition } from '../loader/load';

export interface VersionRecord {
  factory: string;
  commit: string;
  tag: string | null;
  contentHash: string;
  dirty: boolean;
}

const TAG_RE = /^factory-v(\d+)$/;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

  const tags = git(dir, ['tag', '--points-at', 'HEAD'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter((tag) => TAG_RE.test(tag))
    .sort((left, right) => {
      const a = Number(TAG_RE.exec(left)?.[1] ?? 0);
      const b = Number(TAG_RE.exec(right)?.[1] ?? 0);
      return a - b;
    });

  return {
    factory: definition.manifest.name,
    commit,
    tag: tags.length > 0 ? tags[tags.length - 1] : null,
    contentHash: contentHash(definition),
    dirty,
  };
}
