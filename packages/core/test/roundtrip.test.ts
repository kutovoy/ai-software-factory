import { describe, expect, it } from 'bun:test';
import {
  checkFiles,
  isCanonical,
  loadOrThrow,
  serializeDefinition,
  writeFiles,
} from '../src/index';
import { EXAMPLE, LIGHTS_OFF, readTree, tempDir } from './helpers';

const FACTORIES = [
  ['factories/example', EXAMPLE],
  ['factories/example-lights-off', LIGHTS_OFF],
] as const;

describe('canonical round-trip', () => {
  for (const [label, dir] of FACTORIES) {
    it(`export -> import -> export is byte-identical for ${label}`, () => {
      const first = tempDir();
      writeFiles(first, serializeDefinition(loadOrThrow(dir)));

      const imported = loadOrThrow(first);
      const second = tempDir();
      writeFiles(second, serializeDefinition(imported));

      expect(readTree(second)).toEqual(readTree(first));
    });

    it(`export is idempotent when re-exported from the exported tree for ${label}`, () => {
      const definition = loadOrThrow(dir);
      const exported = tempDir();
      writeFiles(exported, serializeDefinition(definition));

      const again = tempDir();
      writeFiles(again, serializeDefinition(loadOrThrow(exported)));

      expect(readTree(again)).toEqual(readTree(exported));
    });

    it(`the checked-in tree is canonical for ${label}`, () => {
      const definition = loadOrThrow(dir);
      const check = checkFiles(dir, serializeDefinition(definition));
      expect(check).toEqual({ missing: [], changed: [], extra: [] });
      expect(isCanonical(check)).toBe(true);
    });
  }

  it('detects a non-canonical file', () => {
    const definition = loadOrThrow(EXAMPLE);
    const check = checkFiles(EXAMPLE, [
      ...serializeDefinition(definition).filter((file) => file.path !== 'factory.yaml'),
      { path: 'factory.yaml', content: 'not canonical\n' },
    ]);
    expect(check.changed).toEqual(['factory.yaml']);
    expect(isCanonical(check)).toBe(false);
  });

  it('detects an extra file', () => {
    const definition = loadOrThrow(EXAMPLE);
    const files = serializeDefinition(definition);
    const check = checkFiles(EXAMPLE, files);
    expect(check.extra).toEqual([]);
  });
});
