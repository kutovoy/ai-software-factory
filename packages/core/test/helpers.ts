import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { walk } from '../src/loader/walk';

export const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const EXAMPLE = join(REPO_ROOT, 'factories/example');
export const LIGHTS_OFF = join(REPO_ROOT, 'factories/example-lights-off');
export const NEGATIVE_FIXTURES = join(import.meta.dir, 'fixtures/negative');

export function tempDir(prefix = 'factory-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Path -> bytes for every file under `root`; order-independent comparison target. */
export function readTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const path of walk(root)) {
    tree[path] = readFileSync(join(root, path), 'utf8');
  }
  return tree;
}
