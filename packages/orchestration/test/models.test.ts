import { describe, expect, test } from 'bun:test';
import {
  JUDGEMENT_CLASSIFICATIONS,
  runWorkflowIdFor,
  stageRunId,
  stageWorkflowId,
  workItemWorkflowId,
  type ReviewerReport,
} from '../src/types';
import {
  deterministicJudgementModel,
  getJudgementModel,
  setJudgementModel,
  type JudgementModel,
} from '../src/models/judgement';
import {
  deterministicReviewerModel,
  getReviewerModel,
  judgeReviewReports as judge,
  setReviewerModel,
} from '../src/models/review';

function report(
  reviewerIndex: number,
  verdict: 'approve' | 'reject',
  confidence = 0.8,
): ReviewerReport {
  return {
    reviewer: `reviewer-${reviewerIndex}`,
    reviewerIndex,
    runId: `run_${reviewerIndex}`,
    verdict,
    findings:
      verdict === 'reject'
        ? [{ reviewer: `reviewer-${reviewerIndex}`, severity: 'blocker', summary: 'missing test' }]
        : [],
    confidence,
  };
}

describe('judge (review committee)', () => {
  test('unanimous approve yields an advisory approve', () => {
    const verdict = judge([report(1, 'approve'), report(2, 'approve')], 2);
    expect(verdict.verdict).toBe('approve');
    expect(verdict.advisory).toBe(true);
    expect(verdict.reviewers).toBe(2);
    expect(verdict.findings).toEqual([]);
  });

  test('disagreement yields needs_human and attaches both reports', () => {
    const verdict = judge([report(1, 'approve'), report(2, 'reject')], 2);
    expect(verdict.verdict).toBe('needs_human');
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]?.reviewer).toBe('reviewer-2');
    expect(verdict.confidence).toBe(0.8);
  });

  test('unanimous reject yields reject', () => {
    expect(judge([report(1, 'reject'), report(2, 'reject')], 2).verdict).toBe('reject');
  });

  test('fewer reports than configured reviewers is incomplete -> needs_human', () => {
    const verdict = judge([report(1, 'approve')], 2);
    expect(verdict.verdict).toBe('needs_human');
    expect(verdict.incomplete).toBe(true);
    expect(verdict.confidence).toBe(0);
  });

});

describe('judgement model', () => {
  test('classifies into the schema-constrained vocabulary', async () => {
    const cases: Array<[string, 'implement' | 'spec' | 'wait' | 'reject']> = [
      ['Add retry to the API client', 'implement'],
      ['Design the retry policy', 'spec'],
      ['Needs clarification on scope', 'wait'],
      ['Duplicate of #42, reject', 'reject'],
    ];
    for (const [title, expected] of cases) {
      const result = await deterministicJudgementModel.classify({
        workItemId: 'wi_test',
        title,
        sourceRef: {},
        prompt: title,
      });
      expect([...JUDGEMENT_CLASSIFICATIONS] as string[]).toContain(result.classification);
      expect(result.classification).toBe(expected);
    }
  });

  test('the model hook can be replaced and reset', () => {
    const scripted: JudgementModel = {
      id: 'scripted',
      classify: async () => ({ classification: 'wait', confidence: 0.1, reason: 'nope' }),
    };
    setJudgementModel(scripted);
    expect(getJudgementModel().id).toBe('scripted');
    setJudgementModel(null);
    expect(getJudgementModel().id).toBe('deterministic');
  });});

describe('reviewer model', () => {
  test('approves a green run and rejects a failed one', async () => {
    const ok = await deterministicReviewerModel.review({
      workItemId: 'wi_test',
      stage: 'review',
      reviewerIndex: 1,
      runId: 'run_1',
      runStatus: 'ok',
    });
    expect(ok.verdict).toBe('approve');

    const failed = await deterministicReviewerModel.review({
      workItemId: 'wi_test',
      stage: 'review',
      reviewerIndex: 2,
      runId: 'run_2',
      runStatus: 'failed',
      summary: 'tests failed',
    });
    expect(failed.verdict).toBe('reject');
    expect(failed.findings[0]?.severity).toBe('blocker');
  });

  test('the reviewer hook can be replaced and reset', () => {
    setReviewerModel({
      id: 'scripted',
      review: async () => ({ verdict: 'reject', findings: [], confidence: 0.2 }),
    });
    expect(getReviewerModel().id).toBe('scripted');
    setReviewerModel(null);
    expect(getReviewerModel().id).toBe('deterministic');
  });
});

describe('workflow ids', () => {
  test('work item, stage and run ids are deterministic and unique per attempt', () => {
    expect(workItemWorkflowId('wi_ABC')).toBe('factory-wi_ABC');
    expect(stageWorkflowId('wi_ABC', 'review', 2, 'r1')).toBe('stage-wi_ABC-review-2-r1');
    expect(stageWorkflowId('wi_ABC', 'review', 2, 'r2')).not.toBe(
      stageWorkflowId('wi_ABC', 'review', 2, 'r1'),
    );
    expect(runWorkflowIdFor('run_1')).toBe('run-run_1');
    expect(stageRunId('wi_ABC', 'review', 2, 1)).toBe('run_ABC_review_2_r1');
  });
});
