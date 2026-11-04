import { describe, expect, test } from 'bun:test';
import { surfaceApiBase } from '../src/surfaces';

describe('surface API base', () => {
  test('adds /api/v1 to an origin', () => {
    expect(surfaceApiBase('http://localhost:8080')).toBe('http://localhost:8080/api/v1');
  });

  test('keeps an already-versioned base', () => {
    expect(surfaceApiBase('http://localhost:8080/api/v1/')).toBe(
      'http://localhost:8080/api/v1',
    );
  });
});
