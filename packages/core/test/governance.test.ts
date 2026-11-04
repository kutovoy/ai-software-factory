import { describe, expect, test } from 'bun:test';
import {
  ModelNotAllowedError,
  assertModelAllowed,
  evaluateActionPolicy,
} from '../src/governance/policy';

describe('governance policy', () => {
  test('deny actions are fail-closed', () => {
    const result = evaluateActionPolicy({ denyActions: ['bash*'] }, 'bash');
    expect(result.decision).toBe('deny');
  });

  test('human-required actions are not auto-allowed', () => {
    const result = evaluateActionPolicy({ requireHumanActions: ['git.push'] }, 'git.push');
    expect(result.decision).toBe('require_human');
  });

  test('observe and assist do not allow unattended actions', () => {
    expect(evaluateActionPolicy({ autonomyLevel: 'observe' }, 'edit').decision).toBe(
      'require_human',
    );
    expect(evaluateActionPolicy({ autonomyLevel: 'assist' }, 'edit').decision).toBe(
      'require_human',
    );
  });

  test('auto and full allow non-denied actions', () => {
    expect(evaluateActionPolicy({ autonomyLevel: 'auto' }, 'edit').decision).toBe('allow');
    expect(evaluateActionPolicy({ autonomyLevel: 'full' }, 'edit').decision).toBe('allow');
  });

  test('model allowlist supports globs', () => {
    expect(() => assertModelAllowed({ allowedModels: ['best_*'] }, 'best_llm')).not.toThrow();
    expect(() => assertModelAllowed({ allowedModels: ['best_*'] }, 'other')).toThrow(
      ModelNotAllowedError,
    );
  });
});
