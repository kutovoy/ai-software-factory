import { serializeDefinition, sha256, type FactoryDefinition } from '@factory/core';
import { assertEditsInScope } from './scope';
import type { ComposedCandidate, ObservedEdit } from './types';

/**
 * Compose (spec `self-improvement` › Compose).
 *
 * Only edits that improved the contrastive signal are applied. The result is a canonical
 * serialized definition plus a per-file diff and a content hash; the caller validates it
 * by loading the candidate tree before publishing, so a composed definition can never be
 * invalid.
 */

export type ComposeErrorCode = 'edit_path_not_found';

export class ComposeError extends Error {
  readonly code: ComposeErrorCode;

  constructor(code: ComposeErrorCode, message: string) {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
  }
}

export interface ComposeOptions {
  /** Apply edits without the scope guard; used only for the audited authority change. */
  skipScopeCheck?: boolean;
}

export function composeCandidate(
  definition: FactoryDefinition,
  edits: ObservedEdit[],
  options: ComposeOptions = {},
): ComposedCandidate {
  if (!options.skipScopeCheck) assertEditsInScope(edits);

  const files = serializeDefinition(definition);
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const diff: ComposedCandidate['diff'] = [];

  for (const edit of edits) {
    const before = contents.get(edit.path);
    if (before === undefined) {
      throw new ComposeError(
        'edit_path_not_found',
        `edit targets "${edit.path}", which is not a file of this definition`,
      );
    }
    if (before === edit.content) continue;
    contents.set(edit.path, edit.content);
    diff.push({ path: edit.path, before, after: edit.content });
  }

  const candidateFiles = [...contents.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const candidateHash = sha256(
    candidateFiles.map((file) => `${file.path}\u0000${sha256(file.content)}`).join('\n'),
  );

  return {
    files: candidateFiles,
    changedPaths: diff.map((entry) => entry.path).sort(),
    diff: diff.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    candidateHash,
  };
}
