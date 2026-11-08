import { describe, expect, test } from 'bun:test';
import {
  assertionsFromWorkItemEvents,
  parsePatchStats,
} from '../src/activities/work-items';
import type { WorkItemEvent } from '@factory/core';

function event(
  type: string,
  payload: Record<string, unknown>,
  id = 1,
): WorkItemEvent {
  return {
    id,
    workItemId: 'wi_01M6QCY01B28JHAMTGNHZRHRRR',
    type,
    stage: 'verify',
    actor: 'qa',
    payload,
    createdAt: null,
  };
}

describe('review packet helpers', () => {
  test('counts changed files and +/- lines from a unified diff', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '-old line',
      '+new line',
      '+another line',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '+only addition',
    ].join('\n');

    expect(parsePatchStats(patch)).toEqual({
      changedFiles: 2,
      additions: 3,
      deletions: 1,
    });
    expect(parsePatchStats('')).toEqual({ changedFiles: 0, additions: 0, deletions: 0 });
  });

  test('maps the newest validation.evidence checks and ignores malformed entries', () => {
    const events = [
      event('validation.evidence', { checks: [{ checkId: 'OLD', status: 'pass' }] }, 1),
      event('gate.requested', { gate: 'human' }, 2),
      event(
        'validation.evidence',
        {
          checks: [
            { checkId: 'VAL-1', status: 'pass', detail: 'exit 0' },
            { id: 'VAL-2', status: 'fail', evidence: 'screenshot shows 500' },
            { status: 'pass' },
            { checkId: 'VAL-3' },
            'not-an-object',
          ],
        },
        3,
      ),
    ];

    expect(assertionsFromWorkItemEvents(events)).toEqual([
      { id: 'VAL-1', status: 'pass', evidence: 'exit 0' },
      { id: 'VAL-2', status: 'fail', evidence: 'screenshot shows 500' },
    ]);
  });

  test('returns no assertions when no evidence event exists', () => {
    expect(
      assertionsFromWorkItemEvents([event('gate.requested', { gate: 'human' })]),
    ).toEqual([]);
  });
});
