import { createHash } from 'node:crypto';
import { serializeDefinition } from './serialize';
import type { FactoryDefinition } from './load';

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Content hash of a definition tree: sha256 over sorted `path\0fileHash` lines.
 * Independent of file order and of the filesystem.
 */
export function contentHash(definition: FactoryDefinition): string {
  const lines = serializeDefinition(definition)
    .map((file) => `${file.path}\0${sha256(file.content)}`)
    .sort();
  return sha256(lines.join('\n'));
}
