import { describe, expect, test } from 'bun:test';
import { DEFAULT_REVIEW_CAPACITY, evaluateReviewCapacity } from '@factory/core';
import {
  oldestGateHoursFrom,
  reviewCapacityRefusalReason,
  reviewPacketDiffLines,
  reviewPacketTopLevelPaths,
} from '../src/review-capacity';

describe('review packet projections', () => {
  test('prefers slopActual.diffLines', () => {
    expect(
      reviewPacketDiffLines({
        slopActual: { diffLines: 321 },
        diffStats: { additions: 1, deletions: 1 },
      }),
    ).toBe(321);
  });

  test('falls back to diffStats additions + deletions', () => {
    expect(
      reviewPacketDiffLines({ slopActual: null, diffStats: { additions: 120, deletions: 30 } }),
    ).toBe(150);
  });

  test('returns zero for missing or malformed payloads', () => {
    expect(reviewPacketDiffLines(null)).toBe(0);
    expect(reviewPacketDiffLines('nope')).toBe(0);
    expect(reviewPacketDiffLines({})).toBe(0);
    expect(reviewPacketDiffLines({ slopActual: { diffLines: Number.NaN } })).toBe(0);
    expect(reviewPacketDiffLines({ diffStats: { additions: 10 } })).toBe(0);
  });

  test('extracts distinct top-level blast-radius segments', () => {
    expect(
      reviewPacketTopLevelPaths({
        blastRadius: {
          paths: ['src/app.ts', 'src/lib/x.ts', 'docs/ADR.md', 'package.json', '/infra/main.tf'],
        },
      }),
    ).toEqual(['src', 'docs', 'package.json', 'infra']);
  });

  test('returns no segments when the packet has no blast radius', () => {
    expect(reviewPacketTopLevelPaths({})).toEqual([]);
    expect(reviewPacketTopLevelPaths({ blastRadius: { paths: [42, null] } })).toEqual([]);
  });
});

describe('oldestGateHoursFrom', () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');

  test('uses the oldest requested_at', () => {
    expect(
      oldestGateHoursFrom(
        ['2026-11-25T10:00:00.000Z', new Date('2026-11-24T12:00:00.000Z')],
        now,
      ),
    ).toBe(24);
  });

  test('returns zero when nothing is pending or timestamps are invalid', () => {
    expect(oldestGateHoursFrom([], now)).toBe(0);
    expect(oldestGateHoursFrom([null, 'not-a-date'], now)).toBe(0);
  });

  test('clamps a future timestamp to zero', () => {
    expect(oldestGateHoursFrom(['2026-11-26T12:00:00.000Z'], now)).toBe(0);
  });
});

describe('review capacity refusal shape', () => {
  test('names every exceeded cap in the refusal reason', () => {
    const status = evaluateReviewCapacity(
      { openGates: 21, unreadDiffLines: 4500, oldestGateHours: 60 },
      DEFAULT_REVIEW_CAPACITY,
    );
    expect(status.saturated).toBe(true);
    expect(reviewCapacityRefusalReason(status)).toBe(
      'review_capacity_exceeded: open gates 21 > 20; unread diff lines 4500 > 4000; oldest gate 60h > 48h',
    );
  });

  test('has a stable fallback when no individual cap is named', () => {
    expect(
      reviewCapacityRefusalReason({
        saturated: true,
        openGates: 0,
        unreadDiffLines: 0,
        oldestGateHours: 0,
        reasons: [],
      }),
    ).toBe('review_capacity_exceeded: review capacity saturated');
  });
});
