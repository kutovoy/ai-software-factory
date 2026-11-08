import { describe, expect, test } from 'bun:test';
import type { WorkItemEvent } from './types';
import { reviewPacket } from './work-items';

/**
 * Review-packet derivation (change `harden-factory-quality`). The API projects the raw
 * `review.packet` event; the console must show the newest packet and treat a malformed or
 * absent payload as absent rather than inventing a risk tier.
 */

function event(id: number, payload: Record<string, unknown>, type = 'review.packet'): WorkItemEvent {
  return {
    id,
    workItemId: 'wi_01J00000000000000000000000',
    type,
    stage: 'review',
    actor: 'foreman',
    payload,
    createdAt: '2026-11-07T00:00:00.000Z',
  };
}

const packet = {
  riskTier: 'high',
  intent: 'Ship the docs route',
  planRef: 'mis_plan',
  changedFiles: 3,
  diffStats: { additions: 12, deletions: 4 },
  assertions: [{ id: 'docs-renders', status: 'pass', evidence: 'playwright report' }],
  architectureImpact: ['new public route'],
  openQuestions: ['does the nav need a link?'],
  reviewerChecklist: ['check layering'],
};

describe('reviewPacket', () => {
  test('returns null when no packet was recorded', () => {
    expect(reviewPacket([event(1, {}, 'stage.changed')])).toBeNull();
  });

  test('reads the newest packet and keeps every field', () => {
    const result = reviewPacket([event(1, { ...packet, riskTier: 'low' }), event(2, packet)]);
    expect(result).toEqual({
      riskTier: 'high',
      intent: 'Ship the docs route',
      planRef: 'mis_plan',
      changedFiles: 3,
      diffStats: { additions: 12, deletions: 4 },
      assertions: [{ id: 'docs-renders', status: 'pass', evidence: 'playwright report' }],
      architectureImpact: ['new public route'],
      openQuestions: ['does the nav need a link?'],
      reviewerChecklist: ['check layering'],
    });
  });

  test('treats a packet without a valid risk tier as absent', () => {
    expect(reviewPacket([event(1, { ...packet, riskTier: 'critical' })])).toBeNull();
    expect(reviewPacket([event(1, { ...packet, riskTier: undefined })])).toBeNull();
  });

  test('normalises missing optional fields instead of crashing', () => {
    expect(reviewPacket([event(1, { riskTier: 'low' })])).toEqual({
      riskTier: 'low',
      intent: '',
      planRef: null,
      changedFiles: 0,
      diffStats: { additions: 0, deletions: 0 },
      assertions: [],
      architectureImpact: [],
      openQuestions: [],
      reviewerChecklist: [],
    });
  });
});
