import type {
  RunEvidence,
  ScoreEvidenceRef,
  TraceCheck,
  TraceMetrics,
} from './types';

/**
 * Trace scoring (roadmap item 6).
 *
 * These checks are deterministic and model-free. They read the canonical run trace:
 * usage events, assistant message lengths, file edits, the patch size and the review
 * gate's structured verdict. The resulting scores flow through the existing scorer /
 * self-improvement path, so a trace failure becomes an evidence-backed definition PR
 * instead of a dashboard-only number.
 */

const TEST_COMMAND_RE =
  /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|bun\s+test|npx\s+playwright\s+test)\b/i;

/** Thresholds are intentionally generous: they flag waste, not normal variation. */
export const TRACE_THRESHOLDS = {
  maxOutputTokens: 6_000,
  maxAssistantChars: 20_000,
  maxChangedFiles: 20,
  maxPatchBytes: 200_000,
  minReviewFindings: 1,
  minReviewSummaryChars: 40,
} as const;

export function isTestCommand(command: string | undefined): boolean {
  return Boolean(command && TEST_COMMAND_RE.test(command));
}

export function computeTraceMetrics(evidence: RunEvidence): TraceMetrics {
  const usage = evidence.usage;
  const messages = evidence.messages;

  const testCounts = new Map<string, number>();
  for (const call of evidence.toolCalls) {
    if (!isTestCommand(call.command)) continue;
    const normalized = (call.command ?? '').replace(/\s+/g, ' ').trim();
    testCounts.set(normalized, (testCounts.get(normalized) ?? 0) + 1);
  }
  const testCommands = [...testCounts.values()].reduce((sum, count) => sum + count, 0);
  const redundantTestCommands = [...testCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );

  return {
    toolCalls: evidence.toolCalls.length,
    failedToolCalls: evidence.toolCalls.filter((call) => !call.ok).length,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costUsd: usage?.costUsd ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    assistantMessages: messages?.assistantMessages ?? 0,
    assistantChars: messages?.assistantChars ?? 0,
    finalSummaryChars: messages?.finalSummaryChars ?? 0,
    fileEdits: evidence.fileEdits.length,
    changedFiles: new Set(evidence.fileEdits.map((edit) => edit.path)).size,
    patchBytes: evidence.patchBytes,
    testCommands,
    redundantTestCommands,
    reviewFindings: evidence.review?.findings ?? 0,
    reviewSummaryChars: evidence.review?.summaryChars ?? 0,
  };
}

export interface TraceCheckResult {
  check: TraceCheck;
  ok: boolean;
  rationale: string;
  evidence: ScoreEvidenceRef[];
}

function eventRef(seq: number | null, detail: Record<string, unknown>): ScoreEvidenceRef {
  return {
    kind: 'event',
    ref: seq === null ? 'event:trace' : `event:${seq}`,
    detail,
  };
}

export function evaluateTraceCheck(
  check: TraceCheck,
  evidence: RunEvidence,
): TraceCheckResult {
  const metrics = computeTraceMetrics(evidence);
  const usageRef = eventRef(null, {
    check,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    costUsd: metrics.costUsd,
  });

  switch (check) {
    case 'redundant_tests': {
      const ok = metrics.redundantTestCommands === 0;
      return {
        check,
        ok,
        rationale: ok
          ? `trace: ${metrics.testCommands} test command(s), no duplicate runs`
          : `trace: ${metrics.redundantTestCommands} redundant test command(s) across ${metrics.testCommands} run(s)`,
        evidence: [
          eventRef(null, {
            check,
            testCommands: metrics.testCommands,
            redundantTestCommands: metrics.redundantTestCommands,
          }),
        ],
      };
    }
    case 'verbosity': {
      const ok =
        metrics.outputTokens <= TRACE_THRESHOLDS.maxOutputTokens &&
        metrics.assistantChars <= TRACE_THRESHOLDS.maxAssistantChars;
      return {
        check,
        ok,
        rationale: ok
          ? `trace: ${metrics.outputTokens} output tokens, ${metrics.assistantChars} assistant chars`
          : `trace: verbosity exceeded (${metrics.outputTokens} output tokens, ${metrics.assistantChars} assistant chars; limits ${TRACE_THRESHOLDS.maxOutputTokens}/${TRACE_THRESHOLDS.maxAssistantChars})`,
        evidence: [usageRef],
      };
    }
    case 'scope': {
      const ok =
        metrics.changedFiles <= TRACE_THRESHOLDS.maxChangedFiles &&
        metrics.patchBytes <= TRACE_THRESHOLDS.maxPatchBytes;
      return {
        check,
        ok,
        rationale: ok
          ? `trace: ${metrics.changedFiles} changed file(s), ${metrics.patchBytes} patch bytes`
          : `trace: scope exceeded (${metrics.changedFiles} changed file(s), ${metrics.patchBytes} patch bytes; limits ${TRACE_THRESHOLDS.maxChangedFiles}/${TRACE_THRESHOLDS.maxPatchBytes})`,
        evidence: [
          eventRef(null, {
            check,
            changedFiles: metrics.changedFiles,
            fileEdits: metrics.fileEdits,
            patchBytes: metrics.patchBytes,
          }),
        ],
      };
    }
    case 'review_usefulness': {
      if (!evidence.review) {
        return {
          check,
          ok: true,
          rationale: 'trace: not a review run (no review gate verdict)',
          evidence: [eventRef(null, { check, applicable: false })],
        };
      }
      const ok =
        metrics.reviewFindings >= TRACE_THRESHOLDS.minReviewFindings &&
        metrics.reviewSummaryChars >= TRACE_THRESHOLDS.minReviewSummaryChars;
      return {
        check,
        ok,
        rationale: ok
          ? `trace: review verdict has ${metrics.reviewFindings} finding(s) and a ${metrics.reviewSummaryChars}-char summary`
          : `trace: review verdict is not useful (${metrics.reviewFindings} finding(s), ${metrics.reviewSummaryChars}-char summary)`,
        evidence: [
          {
            kind: 'work_item',
            ref: 'gate:review',
            detail: {
              check,
              verdict: evidence.review.verdict,
              findings: metrics.reviewFindings,
              summaryChars: metrics.reviewSummaryChars,
            },
          },
        ],
      };
    }
  }
}
