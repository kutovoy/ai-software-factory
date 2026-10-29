import { describe, expect, it } from 'bun:test';
import { loadOrThrow } from '@factory/core';
import { join } from 'node:path';
import {
  CANARY_NOT_AVAILABLE,
  ComposeError,
  EDIT_OUT_OF_SCOPE,
  ProbeError,
  appendLessonFiles,
  assessEligibility,
  composeCandidate,
  createDeterministicProbeRunner,
  decideImprovement,
  dedupeProposals,
  isEditInScope,
  lessonConfidence,
  lessonFromProposal,
  observeScoredCorpus,
  rankProposals,
  runContrastiveProbe,
  scopeViolations,
  visibleLessons,
  type ObservedEdit,
  type ObservedProposal,
  type ScoredRunEvidence,
} from '../src/improve';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EXAMPLE = join(REPO_ROOT, 'factories', 'example');
const definition = loadOrThrow(EXAMPLE);

function run(overrides: Partial<ScoredRunEvidence> = {}): ScoredRunEvidence {
  return {
    runId: 'run_1',
    workItemId: 'wi_1',
    stage: 'implement',
    status: 'ok',
    promptHash: 'a'.repeat(64),
    costUsd: 0.4,
    scores: [
      {
        scorer: 'scope',
        scorerClass: 'judge',
        status: 'ok',
        label: 'compliant',
        score: 1,
        passing: true,
        errorCode: null,
        rationale: 'scoped',
        rubricHash: 'b'.repeat(64),
        uncalibrated: false,
      },
    ],
    ...overrides,
  };
}

function failingRun(id: string, signature = 'scope:non_compliant'): ScoredRunEvidence {
  return run({
    runId: id,
    scores: [
      {
        scorer: 'scope',
        scorerClass: 'judge',
        status: 'ok',
        label: signature.split(':')[1] ?? 'non_compliant',
        score: 0,
        passing: false,
        errorCode: null,
        rationale: 'delivered more than the work item asked for',
        rubricHash: 'b'.repeat(64),
        uncalibrated: false,
      },
    ],
  });
}

describe('blast-radius guard', () => {
  it('accepts the allowed edit paths only', () => {
    for (const path of [
      'agents/implement/agent.md',
      'skills/conventions/SKILL.md',
      'agents/review/skills/check/SKILL.md',
      'routing.yaml',
      'scorers/scope/scorer.md',
      'automations/intake/automation.md',
    ]) {
      expect(isEditInScope(path), path).toBe(true);
    }
    for (const path of [
      'factory.yaml',
      'runners/local-docker.yaml',
      'benchmarks/review/suite.yaml',
      'src/index.ts',
      'packs.lock',
      'agents/implement.md',
    ]) {
      expect(isEditInScope(path), path).toBe(false);
    }
  });

  it('reports edit_out_of_scope for gates, mergePolicy, runners and source', () => {
    const violations = scopeViolations([
      { path: 'factory.yaml' },
      { path: 'runners/local-docker.yaml' },
      { path: 'src/loop.ts' },
      { path: 'agents/spec/agent.md' },
    ]);
    expect(violations.map((violation) => violation.path)).toEqual([
      'factory.yaml',
      'runners/local-docker.yaml',
      'src/loop.ts',
    ]);
    expect(violations.every((violation) => violation.code === EDIT_OUT_OF_SCOPE)).toBe(true);
  });
});

describe('observer', () => {
  it('turns a failing scored corpus into invariant + domain edits with evidence', () => {
    const proposals = observeScoredCorpus(definition, [
      failingRun('run_1'),
      failingRun('run_2'),
      run({ runId: 'run_3' }),
    ]);

    expect(proposals).toHaveLength(1);
    const proposal = proposals[0]!;
    expect(proposal.failureSignature).toBe('scope:non_compliant');
    expect(proposal.evidence.runIds).toEqual(['run_1', 'run_2']);
    expect(proposal.evidence.failedRuns).toBe(2);
    expect(proposal.evidence.totalRuns).toBe(3);
    expect(proposal.impact).toBeGreaterThan(0);
    expect(proposal.edits.map((edit) => edit.kind).sort()).toEqual(['domain', 'invariant']);
    expect(proposal.files).toContain('agents/implement/agent.md');
    expect(proposal.files).toContain('scorers/scope/scorer.md');
    expect(proposal.evidence.scorerRationales[0]?.scorer).toBe('scope');
    for (const edit of proposal.edits) expect(isEditInScope(edit.path)).toBe(true);
  });

  it('treats a non-ok run as a failure signal even when its score passed', () => {
    const proposals = observeScoredCorpus(definition, [
      run({ runId: 'run_cancelled', status: 'cancelled' }),
    ]);
    expect(proposals.map((proposal) => proposal.failureSignature)).toEqual(['run:cancelled']);
  });

  it('is idempotent: an already-applied guardrail produces no edit', () => {
    const first = observeScoredCorpus(definition, [failingRun('run_1')]);
    const edit = first[0]!.edits.find((candidate) => candidate.kind === 'invariant')!;

    // Simulate the definition after the edit was applied by editing the resource body.
    const edited = {
      ...definition,
      resources: definition.resources.map((resource) =>
        resource.path === edit.path
          ? { ...resource, body: `${resource.body}\n\n## Improvement guardrail: scope:non_compliant\n` }
          : resource,
      ),
    };
    const second = observeScoredCorpus(edited, [failingRun('run_1')]);
    expect(second[0]?.edits.some((candidate) => candidate.path === edit.path)).toBe(false);
  });
});

describe('dedupe and ranking', () => {
  function proposal(overrides: Partial<ObservedProposal>): ObservedProposal {
    return {
      title: 't',
      summary: 's',
      failureSignature: 'sig',
      files: ['agents/implement/agent.md'],
      edits: [],
      evidence: {
        runIds: ['run_1'],
        failedRuns: 1,
        totalRuns: 2,
        failureCount: 1,
        costUsd: 0.2,
        scorerRationales: [],
      },
      impact: 1,
      ...overrides,
    };
  }

  it('clusters proposals that share files and failure signature', () => {
    const merged = dedupeProposals([
      proposal({ evidence: { ...proposal({}).evidence, runIds: ['run_1'] }, impact: 1 }),
      proposal({ evidence: { ...proposal({}).evidence, runIds: ['run_2'], failedRuns: 1 }, impact: 2 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidence.runIds).toEqual(['run_1', 'run_2']);
    expect(merged[0]!.impact).toBeGreaterThan(0);
  });

  it('keeps different signatures apart and ranks by impact', () => {
    const ranked = rankProposals([
      proposal({ failureSignature: 'low', impact: 1 }),
      proposal({ failureSignature: 'high', impact: 9 }),
    ]);
    expect(ranked.map((entry) => entry.failureSignature)).toEqual(['high', 'low']);
    expect(dedupeProposals(ranked)).toHaveLength(2);
  });
});

describe('eligibility', () => {
  it('requires the minimum number of scored runs', () => {
    const result = assessEligibility({
      authority: 'propose_only',
      minScoredRuns: 3,
      scoredRuns: 2,
      judges: [{ scorer: 'scope', rubricHash: 'b', judgeModel: 'm', calibrated: true }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('insufficient_scored_runs');
  });

  it('refuses when a judge has no passing calibration', () => {
    const result = assessEligibility({
      authority: 'propose_only',
      minScoredRuns: 1,
      scoredRuns: 4,
      judges: [{ scorer: 'scope', rubricHash: 'b', judgeModel: 'm', calibrated: false }],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('uncalibrated_judges');
    expect(result.uncalibratedJudges).toEqual(['scope']);
  });

  it('is eligible with enough runs and calibrated judges', () => {
    const result = assessEligibility({
      authority: 'auto_merge_on_benchmark',
      minScoredRuns: 2,
      scoredRuns: 2,
      judges: [{ scorer: 'scope', rubricHash: 'b', judgeModel: 'm', calibrated: true }],
    });
    expect(result.eligible).toBe(true);
    expect(result.calibratedJudges).toEqual(['scope']);
  });
});

describe('contrastive probe', () => {
  const workItem = {
    workItemId: 'wi_1',
    runId: 'run_1',
    promptHash: 'a'.repeat(64),
    scorer: 'scope',
    rubricHash: 'b'.repeat(64),
  };
  const identity = {
    workItemId: 'wi_1',
    runId: 'run_1',
    promptHash: 'a'.repeat(64),
    scorer: 'scope',
    rubricHash: 'b'.repeat(64),
  };

  it('records a positive delta as a winner and matched inputs', () => {
    const result = runContrastiveProbe({
      edit: { kind: 'invariant', path: 'agents/implement/agent.md' },
      workItem,
      baseline: { identity, status: 'ok', score: 0, passing: false, uncalibrated: false },
      candidate: { identity, status: 'ok', score: 0.25, passing: false, uncalibrated: false },
    });
    expect(result.winner).toBe(true);
    expect(result.delta).toBe(0.25);
    expect(result.matchedInputs.runId).toBe('run_1');
    expect(result.matchedInputs.editPath).toBe('agents/implement/agent.md');
  });

  it('refuses a probe whose sides did not run the same work item', () => {
    expect(() =>
      runContrastiveProbe({
        edit: { kind: 'domain', path: 'scorers/scope/scorer.md' },
        workItem,
        baseline: { identity, status: 'ok', score: 0, passing: false, uncalibrated: false },
        candidate: {
          identity: { ...identity, runId: 'run_2' },
          status: 'ok',
          score: 1,
          passing: true,
          uncalibrated: false,
        },
      }),
    ).toThrow(ProbeError);
  });

  it('a deterministic runner improves a failed baseline', () => {
    const runner = createDeterministicProbeRunner();
    const outcome = runner({
      edit: { kind: 'invariant', path: 'agents/implement/agent.md' },
      workItem,
      baseline: { identity, status: 'ok', score: 0, passing: false, uncalibrated: false },
    });
    expect(outcome.score).toBe(0.25);
    expect(outcome.identity.runId).toBe('run_1');
  });
});

describe('compose', () => {
  const edit = (path: string, content: string): ObservedEdit => ({
    kind: 'domain',
    path,
    rationale: 'r',
    content,
  });

  it('applies winning edits, records a diff and a content hash', () => {
    const candidate = composeCandidate(definition, [
      edit('agents/implement/agent.md', '---\ndescription: x\n---\n\n# Implementation\n\nEdited.\n'),
    ]);
    expect(candidate.changedPaths).toEqual(['agents/implement/agent.md']);
    expect(candidate.diff).toHaveLength(1);
    expect(candidate.diff[0]!.after).toContain('Edited.');
    expect(candidate.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(candidate.files.length).toBeGreaterThan(1);
  });

  it('refuses an out-of-scope edit', () => {
    expect(() => composeCandidate(definition, [edit('factory.yaml', 'name: hacked\n')])).toThrow();
    try {
      composeCandidate(definition, [edit('runners/local-docker.yaml', 'x: 1\n')]);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(EDIT_OUT_OF_SCOPE);
    }
  });

  it('reports a missing target path instead of inventing a file', () => {
    expect(() => composeCandidate(definition, [edit('agents/nobody/agent.md', 'x')])).toThrow(
      ComposeError,
    );
  });
});

describe('authority routing', () => {
  const probe = { baselineScore: 0, candidateScore: 0.25, uncalibrated: false };
  const benchmark = {
    attestationPassed: true,
    attestationCalibrated: true,
    commitMatches: true,
    configHash: 'c'.repeat(64),
  };

  it('propose_only always opens a PR', () => {
    const decision = decideImprovement({
      authority: 'propose_only',
      hasCandidate: true,
      probe,
      benchmark,
    });
    expect(decision.action).toBe('open_pr');
  });

  it('auto_merge refuses without a matching benchmark attestation', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: true,
      probe,
      benchmark: null,
    });
    expect(decision.action).toBe('open_pr');
    expect(decision.code).toBe('benchmark_attestation_missing');
  });

  it('auto_merge refuses an uncalibrated probe', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: true,
      probe: { ...probe, uncalibrated: true },
      benchmark,
    });
    expect(decision.action).toBe('open_pr');
    expect(decision.code).toBe('benchmark_uncalibrated');
  });

  it('auto_merge merges on benchmark non-regression', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: true,
      probe,
      benchmark,
    });
    expect(decision.action).toBe('merge');
    expect(decision.code).toBe('benchmark_non_regression');
  });

  it('canary returns canary_not_available, flagged Phase 5b', () => {
    const decision = decideImprovement({
      authority: 'canary',
      hasCandidate: true,
      probe,
      benchmark,
    });
    expect(decision.action).toBe('canary_not_available');
    expect(decision.code).toBe(CANARY_NOT_AVAILABLE);
    expect(decision.phase).toBe('5b');
  });

  it('no candidate means no_improvement', () => {
    const decision = decideImprovement({
      authority: 'auto_merge_on_benchmark',
      hasCandidate: false,
      probe: null,
      benchmark,
    });
    expect(decision.action).toBe('no_improvement');
  });
});

describe('experience library', () => {
  const proposal = {
    failureSignature: 'scope:non_compliant',
    title: 'Fix scope:non_compliant',
    summary: '2 of 3 runs failed.',
    files: ['agents/implement/agent.md'],
    evidence: { runIds: ['run_1', 'run_2'], failedRuns: 2, totalRuns: 3, costUsd: 0.8 },
  };

  it('bounds confidence and derives a cue/lesson/evidence record', () => {
    const lesson = lessonFromProposal({
      proposal,
      decision: decideImprovement({
        authority: 'propose_only',
        hasCandidate: true,
        probe: { baselineScore: 0, candidateScore: 0.25, uncalibrated: false },
        benchmark: null,
      }),
      probeDelta: 0.25,
    });
    expect(lesson.cue).toBe('scope:non_compliant');
    expect(lesson.confidence).toBeGreaterThan(0);
    expect(lesson.confidence).toBeLessThanOrEqual(1);
    expect(lesson.evidence.runIds).toEqual(['run_1', 'run_2']);
    expect(lessonConfidence({ probeDelta: 10, failedRuns: 100 })).toBe(0.95);
  });

  it('appends idempotently to INDEX.md and EXPERIENCE.md', () => {
    const lesson = lessonFromProposal({
      proposal,
      decision: decideImprovement({
        authority: 'propose_only',
        hasCandidate: true,
        probe: { baselineScore: 0, candidateScore: 0.25, uncalibrated: false },
        benchmark: null,
      }),
      probeDelta: 0.25,
    });
    const first = appendLessonFiles({ factory: 'example', index: null, experience: null, lesson });
    expect(first.appended).toBe(true);
    expect(first.index).toContain('| `scope:non_compliant` |');
    expect(first.experience).toContain('## `scope:non_compliant`');
    expect(first.experience).toContain('- Confidence:');

    const second = appendLessonFiles({
      factory: 'example',
      index: first.index,
      experience: first.experience,
      lesson,
    });
    expect(second.appended).toBe(false);
    expect(second.experience).toBe(first.experience);
  });

  it('isolates lessons: another factory sees only promoted ones', () => {
    const lessons = [
      { factory: 'example', promoted: false, cue: 'a' },
      { factory: 'other', promoted: false, cue: 'b' },
      { factory: 'other', promoted: true, cue: 'c' },
    ];
    expect(visibleLessons(lessons, 'example').map((lesson) => lesson.cue)).toEqual(['a', 'c']);
    expect(visibleLessons(lessons, 'other').map((lesson) => lesson.cue)).toEqual(['b', 'c']);
  });
});
