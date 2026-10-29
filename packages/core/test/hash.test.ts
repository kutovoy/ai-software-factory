import { describe, expect, it } from 'bun:test';
import {
  contentHash,
  loadOrThrow,
  serializeDefinition,
  sha256,
  writeFiles,
} from '../src/index';
import { EXAMPLE, LIGHTS_OFF, readTree, tempDir } from './helpers';

describe('content hash', () => {
  it('is stable across loads', () => {
    expect(contentHash(loadOrThrow(EXAMPLE))).toBe(contentHash(loadOrThrow(EXAMPLE)));
  });

  it('differs between the reference factories', () => {
    expect(contentHash(loadOrThrow(EXAMPLE))).not.toBe(contentHash(loadOrThrow(LIGHTS_OFF)));
  });

  it('is independent of resource order', () => {
    const definition = loadOrThrow(EXAMPLE);
    const reversed = { ...definition, resources: [...definition.resources].reverse() };
    expect(contentHash(reversed)).toBe(contentHash(definition));
  });

  it('is independent of the on-disk file order and survives a round-trip', () => {
    const definition = loadOrThrow(EXAMPLE);
    const out = tempDir();
    writeFiles(out, serializeDefinition(definition));
    expect(contentHash(loadOrThrow(out))).toBe(contentHash(definition));
  });

  it('is a hex sha256 of the sorted file manifest', () => {
    const definition = loadOrThrow(EXAMPLE);
    const files = serializeDefinition(definition);
    const expected = sha256(
      files
        .map((file) => `${file.path}\0${sha256(file.content)}`)
        .sort()
        .join('\n'),
    );
    expect(contentHash(definition)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any byte of a file changes', () => {
    const definition = loadOrThrow(EXAMPLE);
    const changed = structuredClone(definition);
    changed.resources[0].body = `${changed.resources[0].body}extra\n`;
    expect(contentHash(changed)).not.toBe(contentHash(definition));
    expect(readTree(EXAMPLE)['factory.yaml']).toBeTruthy();
  });
});
