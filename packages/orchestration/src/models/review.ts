import type {
  ReviewFinding,
  ReviewerReport,
  ReviewVerdict,
} from '../types';

/**
 * Review committee.
 *
 * Reviewers are independent child workflows, each running on the same commit and
 * returning a structured findings report. A judge merges the reports into one **advisory**
 * verdict `{verdict, findings[], confidence}`. Nothing here can approve a PR or merge it:
 * the verdict is advisory and the review gate decides.
 *
 * Disagreement between reviewers, or fewer reports than configured, resolves to
 * `needs_human` (spec: review committee).
 */

export interface ReviewerModelInput {
  workItemId: string;
  stage: string;
  reviewerIndex: number;
  runId: string | null;
  runStatus: 'ok' | 'failed' | 'cancelled';
  summary?: string;
  findings?: ReviewFinding[];
}

export interface ReviewerModelOutput {
  verdict: 'approve' | 'reject';
  findings: ReviewFinding[];
  confidence: number;
}

export interface ReviewerModel {
  readonly id: string;
  review(input: ReviewerModelInput): Promise<ReviewerModelOutput>;
}

export const deterministicReviewerModel: ReviewerModel = {
  id: 'deterministic',
  async review(input: ReviewerModelInput): Promise<ReviewerModelOutput> {
    if (input.runStatus !== 'ok') {
      return {
        verdict: 'reject',
        findings: [
          {
            reviewer: `reviewer-${input.reviewerIndex}`,
            severity: 'blocker',
            summary: `review run ended ${input.runStatus}: ${input.summary ?? 'no summary'}`,
          },
        ],
        confidence: 0.9,
      };
    }
    return { verdict: 'approve', findings: [], confidence: 0.8 };
  },
};

let current: ReviewerModel = deterministicReviewerModel;

export function getReviewerModel(): ReviewerModel {
  return current;
}

/** Test hook: install a scripted reviewer (used to force disagreement deterministically). */
export function setReviewerModel(next: ReviewerModel | null): void {
  current = next ?? deterministicReviewerModel;
}

/**
 * Deterministic judge. Merges reviewer reports into one advisory verdict:
 *  - fewer reports than configured reviewers -> `needs_human` (incomplete);
 *  - reviewers disagree -> `needs_human`;
 *  - unanimous approve -> `approve`; unanimous reject -> `reject`.
 */
export function judgeReviewReports(
  reports: readonly ReviewerReport[],
  minReviewers: number,
): ReviewVerdict {
  const findings = reports.flatMap((report) => report.findings);
  const reviewers = reports.length;

  if (reviewers < minReviewers) {
    return {
      verdict: 'needs_human',
      findings,
      confidence: 0,
      reviewers,
      advisory: true,
      incomplete: true,
    };
  }

  const verdicts = new Set(reports.map((report) => report.verdict));
  const confidence = Math.min(...reports.map((report) => report.confidence));

  if (verdicts.size > 1) {
    return { verdict: 'needs_human', findings, confidence, reviewers, advisory: true };
  }

  return {
    verdict: verdicts.has('approve') ? 'approve' : 'reject',
    findings,
    confidence,
    reviewers,
    advisory: true,
  };
}
