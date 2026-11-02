import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import type { FileChange } from '@factory/forge';

/**
 * Turns a captured `patch.diff` into concrete `FileChange[]` for the code forge.
 *
 * The forge commits *files*, not patch text: a pull request has to contain the code the
 * implement stage produced, otherwise review/QA on the PR branch inspects a `.patch` blob
 * instead of the change. The diff is applied to a snapshot of the branch (what
 * `forge.checkout` returned) inside a throwaway git repo, then the resulting tree is
 * diffed against that snapshot.
 *
 * Errors are stable codes (`patch_empty`, `patch_binary_unsupported`, `patch_apply_failed`)
 * so the workflow fails the stage with an actionable reason instead of retrying forever.
 */

export const PATCH_ERROR_CODES = [
  /** The captured diff has no content (an empty implement run). */
  'patch_empty',
  /** Binary diffs are not supported by the text-based file API of the forge. */
  'patch_binary_unsupported',
  /** `git apply` rejected the diff (stale context, wrong base, malformed patch). */
  'patch_apply_failed',
] as const;

export type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number];

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly details?: unknown;

  constructor(code: PatchErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.details = details;
  }
}

/** Binary diffs carry these markers; `git apply` can apply them but the forge API cannot. */
const BINARY_MARKERS = ['GIT binary patch', 'Binary files '];

function looksBinary(patch: string): boolean {
  return BINARY_MARKERS.some((marker) => patch.includes(marker));
}

/** Rejects paths that would escape the workspace when materialising the snapshot. */
function safeRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new PatchError('patch_apply_failed', `refusing unsafe snapshot path "${path}"`, {
      path,
    });
  }
  return normalized;
}

async function runGit(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Materialises the branch snapshot as a git repo so `git apply` has a worktree to patch. */
async function writeSnapshot(repo: string, base: Record<string, string>): Promise<void> {
  await mkdir(repo, { recursive: true });
  for (const [path, content] of Object.entries(base)) {
    const target = join(repo, safeRelativePath(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  const init = await runGit(['init', '-q'], repo);
  if (init.code !== 0) {
    throw new PatchError('patch_apply_failed', 'cannot initialise the patch workspace', {
      stderr: init.stderr.slice(-2000),
    });
  }
}

async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    // `.git` is the throwaway repository itself, never part of the change.
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, full)));
    else files.push(relative(root, full).split(sep).join('/'));
  }
  return files;
}

/**
 * Applies `patch` (a unified diff) to `base` (path -> content at the branch head) and
 * returns the resulting file changes: added and modified files carry their new content,
 * deleted files carry `null`. Unchanged files are omitted.
 */
export async function applyPatch(
  base: Record<string, string>,
  patch: string,
): Promise<FileChange[]> {
  if (patch.trim().length === 0) {
    throw new PatchError('patch_empty', 'the captured patch is empty');
  }
  if (looksBinary(patch)) {
    throw new PatchError(
      'patch_binary_unsupported',
      'binary diffs cannot be committed through the file API',
    );
  }

  const root = await mkdtemp(join(tmpdir(), 'factory-patch-'));
  const repo = join(root, 'repo');
  const patchFile = join(root, 'patch.diff');

  try {
    await writeSnapshot(repo, base);
    await writeFile(patchFile, patch, 'utf8');

    const applied = await runGit(['apply', '--whitespace=nowarn', patchFile], repo);
    if (applied.code !== 0) {
      throw new PatchError('patch_apply_failed', 'git apply rejected the captured patch', {
        stderr: applied.stderr.slice(-2000),
      });
    }

    const paths = (await walk(repo)).sort();
    const present = new Set(paths);
    const changes: FileChange[] = [];

    for (const path of paths) {
      const content = await readFile(join(repo, path), 'utf8');
      if (base[path] !== content) changes.push({ path, content });
    }
    for (const path of Object.keys(base).sort()) {
      if (!present.has(path)) changes.push({ path, content: null });
    }

    return changes;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
