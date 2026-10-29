import type { ScoreDraft } from '@factory/evals';
import type { ScoringPlanItem } from '../types';

/**
 * Workflow-safe draft builders. A scorer failure becomes an `error` score; a judge skipped
 * by the daily budget becomes a `skipped` score. Neither touches the run.
 */

export function errorScoreDraft(
  factory: string,
  item: ScoringPlanItem,
  errorCode: string,
  rationale: string,
): ScoreDraft {
  return {
    factory,
    runId: item.runId,
    workItemId: item.workItemId,
    stage: item.stage,
    scorer: item.scorer,
    scorerClass: item.scorerClass,
    rubricHash: item.rubricHash,
    status: 'error',
    errorCode,
    label: null,
    score: null,
    passing: false,
    rationale,
    evidenceRefs: [],
    evidence: [],
    uncalibrated: false,
    provenance: null,
  };
}

export function skippedScoreDraft(
  factory: string,
  item: ScoringPlanItem,
  reason: string,
  rationale: string,
): ScoreDraft {
  return {
    factory,
    runId: item.runId,
    workItemId: item.workItemId,
    stage: item.stage,
    scorer: item.scorer,
    scorerClass: item.scorerClass,
    rubricHash: item.rubricHash,
    status: 'skipped',
    errorCode: reason,
    label: null,
    score: null,
    passing: false,
    rationale,
    evidenceRefs: [],
    evidence: [],
    uncalibrated: false,
    provenance: null,
  };
}
