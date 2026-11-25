import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_QUALITY_STANDARDS,
  DEFAULT_SLOP_BUDGETS,
  evaluateSlopBudget,
  parsePatchMetrics,
  type WorkItemEvent,
} from '@factory/core';
import {
  assertionsFromWorkItemEvents,
  blastRadiusFor,
  buildReadFirst,
  classifyProofArtifact,
  comprehensionFor,
  decisionsFromEvents,
  parsePatchStats,
  parseStandards,
  reviewerRolesFor,
  slopActualFor,
  slopMetricsFromEvents,
  standardsFor,
} from '../src/activities/work-items';

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

/** Six files, 50 added lines each: 300 diff lines / 6 files (over the low budget). */
function bigPatch(): string {
  const lines: string[] = [];
  for (let file = 0; file < 6; file += 1) {
    lines.push(`diff --git a/src/f${file}.ts b/src/f${file}.ts`);
    lines.push(`--- a/src/f${file}.ts`);
    lines.push(`+++ b/src/f${file}.ts`);
    lines.push('@@ -1,0 +1,50 @@');
    for (let index = 0; index < 50; index += 1) lines.push(`+line ${index}`);
  }
  return lines.join('\n');
}

const SMALL_PATCH = [
  'diff --git a/src/api/users.ts b/src/api/users.ts',
  '--- a/src/api/users.ts',
  '+++ b/src/api/users.ts',
  '@@ -1 +1,3 @@',
  '-old',
  '+new',
  '+another',
  '+third',
  'diff --git a/db/schema.sql b/db/schema.sql',
  '--- a/db/schema.sql',
  '+++ b/db/schema.sql',
  '@@ -1 +1 @@',
  '+create table users (id int);',
  'diff --git a/web/app/page.tsx b/web/app/page.tsx',
  '--- a/web/app/page.tsx',
  '+++ b/web/app/page.tsx',
  '@@ -1 +1,2 @@',
  '+export default function Page() { return null; }',
  '+// done',
].join('\n');

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

  test('parsePatchStats delegates to parsePatchMetrics', () => {
    const metrics = parsePatchMetrics(SMALL_PATCH);
    expect(parsePatchStats(SMALL_PATCH)).toEqual({
      changedFiles: metrics.changedFiles,
      additions: metrics.additions,
      deletions: metrics.deletions,
    });
    expect(metrics.changedFiles).toBe(3);
    expect(metrics.files.map((file) => file.path)).toEqual([
      'src/api/users.ts',
      'db/schema.sql',
      'web/app/page.tsx',
    ]);
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

describe('review packet v2 facts', () => {
  test('a patch above the low budget is exceeded and names every overage', () => {
    const metrics = parsePatchMetrics(bigPatch());
    const evaluation = evaluateSlopBudget(
      slopActualFor(metrics, { duplicationDeltaPercent: null, complexityDelta: null }),
      DEFAULT_SLOP_BUDGETS.low,
    );

    expect(metrics.diffLines).toBe(300);
    expect(evaluation.status).toBe('exceeded');
    expect(evaluation.overages.map((overage) => overage.metric).sort()).toEqual([
      'maxChangedFiles',
      'maxDiffLines',
    ]);
  });

  test('unknown duplication/complexity never fails the budget on its own', () => {
    const metrics = parsePatchMetrics(SMALL_PATCH);
    const evaluation = evaluateSlopBudget(
      slopActualFor(metrics, { duplicationDeltaPercent: null, complexityDelta: null }),
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(evaluation.status).toBe('pass');

    const withDeltas = evaluateSlopBudget(
      slopActualFor(metrics, { duplicationDeltaPercent: 4, complexityDelta: 12 }),
      DEFAULT_SLOP_BUDGETS.low,
    );
    expect(withDeltas.status).toBe('exceeded');
    expect(withDeltas.overages.map((overage) => overage.metric)).toContain(
      'maxDuplicationDeltaPercent',
    );
  });

  test('reads duplication/complexity metrics from the newest validation evidence', () => {
    const events = [
      event(
        'validation.evidence',
        {
          checks: [
            {
              checkId: 'VAL-MAINT',
              status: 'pass',
              metrics: { maxDuplicationPercent: 1.5, maxComplexity: 7 },
            },
          ],
        },
        1,
      ),
      event(
        'validation.evidence',
        {
          checks: [
            {
              checkId: 'VAL-MAINT',
              status: 'pass',
              metrics: { duplicationDeltaPercent: 0.5, complexityDelta: 3 },
            },
          ],
        },
        2,
      ),
    ];

    expect(slopMetricsFromEvents(events)).toEqual({
      duplicationDeltaPercent: 0.5,
      complexityDelta: 3,
    });
    expect(slopMetricsFromEvents([event('gate.requested', { gate: 'human' })])).toEqual({
      duplicationDeltaPercent: null,
      complexityDelta: null,
    });
  });

  test('blast radius reports high-risk, public API and schema paths', () => {
    const metrics = parsePatchMetrics(SMALL_PATCH);
    const blastRadius = blastRadiusFor(metrics, ['src/api/**']);

    expect(blastRadius.paths).toEqual([
      'src/api/users.ts',
      'db/schema.sql',
      'web/app/page.tsx',
    ]);
    expect(blastRadius.highRiskPaths).toEqual(['src/api/users.ts']);
    expect(blastRadius.publicApiChanges).toBe(1);
    expect(blastRadius.schemaChanges).toBe(1);
  });

  test('standards pass within caps and exceed when a count is above', () => {
    const metrics = parsePatchMetrics(SMALL_PATCH);
    const blastRadius = blastRadiusFor(metrics, []);

    expect(standardsFor(blastRadius, DEFAULT_QUALITY_STANDARDS)).toEqual({
      maxPublicApiChanges: 5,
      maxSchemaChanges: 3,
      publicApiChanges: 1,
      schemaChanges: 1,
      status: 'pass',
    });

    const exceeded = standardsFor(blastRadius, {
      ...DEFAULT_QUALITY_STANDARDS,
      maxPublicApiChanges: 0,
    });
    expect(exceeded.status).toBe('exceeded');
    expect(exceeded.maxPublicApiChanges).toBe(0);
  });

  test('stored standards parse defensively, re-deriving a missing status', () => {
    expect(parseStandards(undefined, DEFAULT_QUALITY_STANDARDS)).toEqual({
      maxPublicApiChanges: 5,
      maxSchemaChanges: 3,
      publicApiChanges: 0,
      schemaChanges: 0,
      status: 'pass',
    });
    expect(
      parseStandards(
        { maxPublicApiChanges: 1, maxSchemaChanges: 1, publicApiChanges: 2, schemaChanges: 0 },
        DEFAULT_QUALITY_STANDARDS,
      ),
    ).toMatchObject({ status: 'exceeded', publicApiChanges: 2, maxPublicApiChanges: 1 });
    expect(
      parseStandards({ status: 'pass', publicApiChanges: 9, maxPublicApiChanges: 1 }, DEFAULT_QUALITY_STANDARDS),
    ).toMatchObject({ status: 'pass', maxSchemaChanges: 3 });
  });

  test('read-first puts high-risk files first, then the largest change', () => {
    const metrics = parsePatchMetrics(SMALL_PATCH);
    const readFirst = buildReadFirst(metrics.files, ['src/api/users.ts']);

    expect(readFirst[0]?.path).toBe('src/api/users.ts');
    expect(readFirst[0]?.why).toContain('high-risk path');
    expect(readFirst).toHaveLength(3);
    expect(readFirst.map((entry) => entry.path)).toEqual([
      'src/api/users.ts',
      'web/app/page.tsx',
      'db/schema.sql',
    ]);
    expect(readFirst[1]?.why).toBe('largest change');
    expect(readFirst[2]?.why).toContain('touches public API/schema');
  });

  test('reviewer roles follow the change shape', () => {
    expect(
      reviewerRolesFor({
        architectureImpact: ['no upward imports'],
        highRiskPaths: ['src/api/users.ts'],
        paths: ['web/app/page.tsx'],
      }),
    ).toEqual(['correctness', 'architecture', 'security', 'product']);

    expect(reviewerRolesFor({ paths: ['src/core.ts'] })).toEqual(['correctness']);
  });

  test('comprehension estimates read time and counts files without tests', () => {
    const comprehension = comprehensionFor(
      [
        { path: 'src/a.ts', additions: 1, deletions: 0 },
        { path: 'src/a.test.ts', additions: 1, deletions: 0 },
        { path: 'e2e/flow.spec.ts', additions: 1, deletions: 0 },
      ],
      401,
    );
    expect(comprehension).toEqual({
      estimatedReadMinutes: 3,
      filesWithoutTests: 1,
      modulesWithoutOwner: 0,
    });
    expect(comprehensionFor([], 0).estimatedReadMinutes).toBe(1);
  });

  test('decisions map gate decisions and review verdicts newest first', () => {
    const events: WorkItemEvent[] = [
      {
        ...event('gate.decided', {
          decision: 'approve',
          actor: 'alice',
          reason: 'looks good',
          attempt: 1,
        }, 1),
        stage: 'review',
        createdAt: '2026-11-20T10:00:00.000Z',
      },
      {
        ...event('review.verdict', {
          verdict: 'needs_human',
          reviewer: 'reviewer-1',
          findings: [{ summary: 'missing tests' }, { summary: 'unclear error path' }],
        }, 2),
        stage: 'review',
        actor: 'reviewer-1',
        createdAt: '2026-11-20T11:00:00.000Z',
      },
      {
        ...event('gate.decided', {
          decision: 'request_changes',
          actor: 'bob',
          feedback: 'add a test',
          attempt: 2,
        }, 3),
        stage: 'review',
        createdAt: '2026-11-20T12:00:00.000Z',
      },
    ];

    expect(decisionsFromEvents(events)).toEqual([
      {
        at: '2026-11-20T12:00:00.000Z',
        actor: 'bob',
        decision: 'request_changes',
        reason: 'add a test',
        ref: 'gate:review:2',
      },
      {
        at: '2026-11-20T11:00:00.000Z',
        actor: 'reviewer-1',
        decision: 'needs_human',
        reason: 'missing tests; unclear error path',
        ref: 'review:review:reviewer-1',
      },
      {
        at: '2026-11-20T10:00:00.000Z',
        actor: 'alice',
        decision: 'approve',
        reason: 'looks good',
        ref: 'gate:review:1',
      },
    ]);
    expect(decisionsFromEvents(events, 1)).toHaveLength(1);
  });

  test('proof artifacts classify by extension and name', () => {
    expect(classifyProofArtifact('artifacts/home.png')).toBe('screenshot');
    expect(classifyProofArtifact('artifacts/demo.webm')).toBe('video');
    expect(classifyProofArtifact('artifacts/report.html')).toBe('html');
    expect(classifyProofArtifact('artifacts/curl-transcript.txt')).toBe('curl');
    expect(classifyProofArtifact('artifacts/junit-results.xml')).toBe('report');
    expect(classifyProofArtifact('artifacts/binary.bin')).toBe('file');
  });
});
