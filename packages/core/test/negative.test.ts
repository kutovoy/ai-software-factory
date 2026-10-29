import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, loadDefinition } from '../src/index';
import { NEGATIVE_FIXTURES } from './helpers';

const fixtureDirs = readdirSync(NEGATIVE_FIXTURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('negative fixtures', () => {
  it('covers every stable error code that a fixture can trigger', () => {
    const covered = new Set(fixtureDirs);
    // `dirty_worktree` comes from version pinning, not from loading a tree.
    const expected = ERROR_CODES.filter((code) => code !== 'dirty_worktree');
    for (const code of expected) {
      expect(covered.has(code)).toBe(true);
    }
  });

  for (const name of fixtureDirs) {
    it(`reports ${name}`, () => {
      const { definition, errors } = loadDefinition(join(NEGATIVE_FIXTURES, name));
      expect(definition).toBeNull();
      expect(errors.map((error) => error.code)).toContain(name);
      for (const error of errors) {
        expect(Object.keys(error).sort()).toEqual(['code', 'file', 'message', 'pointer']);
        expect(error.file.length).toBeGreaterThan(0);
        expect(error.pointer.startsWith('/')).toBe(true);
        expect(error.message.length).toBeGreaterThan(0);
      }
    });
  }
});
