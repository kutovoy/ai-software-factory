import { describe, expect, test } from 'bun:test';
import { decodeCursor, encodeCursor } from '../src/cursor';

describe('keyset cursors', () => {
  test('round-trips a timestamp and id', () => {
    const cursor = encodeCursor('2026-11-03T12:34:56.789Z', 'wi_01M6J3HS2V0BR9QAGHA399FAYD');
    expect(decodeCursor(cursor)).toEqual({
      at: '2026-11-03T12:34:56.789Z',
      id: 'wi_01M6J3HS2V0BR9QAGHA399FAYD',
    });
  });

  test('rejects a missing, malformed or non-timestamp cursor', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('not-base64')).toBeNull();
    expect(decodeCursor(encodeCursor('not-a-date', 'wi_1'))).toBeNull();
  });
});
