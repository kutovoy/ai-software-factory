import { describe, expect, test } from 'bun:test';
import type { GateDecisionRecord, WorkItemEvent } from './types';
import { decisionTrail, reviewPacket } from './work-items';

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

  test('surfaces the standards result only when the packet carries it', () => {
    const standards = {
      maxPublicApiChanges: 5,
      maxSchemaChanges: 3,
      publicApiChanges: 6,
      schemaChanges: 1,
      status: 'exceeded' as const,
    };
    expect(reviewPacket([event(1, { ...packet, standards })])?.standards).toEqual(standards);
    expect(reviewPacket([event(1, packet)])?.standards).toBeUndefined();
    // An unknown status is normalised to `pass`, never invented as exceeded.
    expect(
      reviewPacket([event(1, { ...packet, standards: { ...standards, status: 'unknown' } })])
        ?.standards?.status,
    ).toBe('pass');
  });
});

/**
 * Decision trail (change `add-review-capacity-and-compounding`): one chronological list from
 * the plan ref through decided gates, review verdicts, the PR, the merge and incidents. Only
 * recorded artifacts contribute — nothing is fabricated to fill the card.
 */

function trailEvent(
  id: number,
  type: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
  actor: string | null = 'foreman',
): WorkItemEvent {
  return {
    id,
    workItemId: 'wi_01J00000000000000000000000',
    type,
    stage: null,
    actor,
    payload,
    createdAt,
  };
}

function gate(overrides: Partial<GateDecisionRecord> = {}): GateDecisionRecord {
  return {
    workItemId: 'wi_01J00000000000000000000000',
    stage: 'review',
    attempt: 1,
    gate: 'human',
    workflowId: null,
    decision: 'approve',
    actor: 'ada',
    reason: 'looks right',
    feedback: null,
    verdict: null,
    automatic: false,
    requestedAt: '2026-11-07T00:00:00.000Z',
    slaAt: null,
    decidedAt: '2026-11-07T01:00:00.000Z',
    ...overrides,
  };
}

describe('decisionTrail', () => {
  test('returns no rows when nothing was recorded', () => {
    expect(decisionTrail({ planRef: null, gates: [], events: [] })).toEqual([]);
  });

  test('orders plan, gate, review, PR and merge chronologically', () => {
    const rows = decisionTrail({
      planRef: 'mis_1#mft_1',
      gates: [gate()],
      events: [
        trailEvent(1, 'review.packet', '2026-11-07T00:30:00.000Z', { planRef: 'mis_1#mft_1' }),
        trailEvent(2, 'review.verdict', '2026-11-07T00:45:00.000Z', {
          reviewer: 'reviewer-1',
          verdict: 'approve',
          confidence: 0.9,
        }),
        trailEvent(3, 'pr.opened', '2026-11-07T02:00:00.000Z', { prUrl: 'https://forge.local/pr/7', prNumber: 7 }),
        trailEvent(4, 'merge.merged', '2026-11-07T03:00:00.000Z', { sha: 'abc123' }),
      ],
    });

    expect(rows.map((row) => row.kind)).toEqual(['plan', 'review', 'gate', 'pr', 'merge']);
    expect(rows[0]?.ref).toBe('mis_1#mft_1');
    expect(rows[0]?.at).toBe('2026-11-07T00:30:00.000Z');
    expect(rows[2]?.decision).toBe('review approve');
    expect(rows[2]?.reason).toBe('looks right');
    expect(rows[3]?.decision).toBe('PR #7 opened');
    expect(rows[4]?.ref).toBe('abc123');
  });

  test('skips a pending gate and does not invent a plan ref', () => {
    const rows = decisionTrail({
      planRef: null,
      gates: [gate({ decision: null, actor: null, decidedAt: null })],
      events: [],
    });
    expect(rows).toEqual([]);
  });

  test('records an incident or revert when present', () => {
    const rows = decisionTrail({
      planRef: null,
      gates: [],
      events: [
        trailEvent(1, 'merge.reverted', '2026-11-07T04:00:00.000Z', { reason: 'checks regressed' }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('incident');
    expect(rows[0]?.decision).toBe('reverted');
    expect(rows[0]?.reason).toBe('checks regressed');
  });

  test('uses the ship status event as the merge row when no merge event exists', () => {
    const rows = decisionTrail({
      planRef: null,
      gates: [],
      events: [
        trailEvent(1, 'work_item.status', '2026-11-07T05:00:00.000Z', { reason: 'merged on green' }),
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('merge');
    expect(rows[0]?.at).toBe('2026-11-07T05:00:00.000Z');
  });
});
