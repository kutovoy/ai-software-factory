import {
  benchmarkConfigHash,
  decideImprovement,
  loadBenchmarkSuites,
  type BenchmarkNonRegressionEvidence,
  type ImprovementDecision,
} from '@factory/evals';
import {
  findBenchmarkAttestation,
  loadDefinition,
  serializeDefinition,
  type ProposalRecord,
} from '@factory/core';
import { FakeForge, ForgeError, type FileChange, type RepoRef } from '@factory/forge';
import { getSql } from './db';
import { getForge } from './activities/forge';
import type { ImprovementAuthorityName } from './types';

/**
 * Applies one improvement decision: PR for `propose_only`, PR-or-merge for
 * `auto_merge_on_benchmark`, and a `canary` decision that the caller turns into a real
 * rollout (Phase 5b, ADR-021). Shared by the workflow activity and
 * `POST /proposals/:id/apply` so the two paths cannot drift.
 */

export interface ApplyImprovementArgs {
  factory: string;
  factoryRoot: string;
  definitionCommit: string;
  /** `owner/name` of the git repo that hosts definitions (fake forge in CI). */
  definitionRepo: string;
  baseBranch?: string;
  authority: ImprovementAuthorityName;
  proposal: ProposalRecord;
  candidateHash: string;
  diff: { path: string; before: string; after: string }[];
  probe: {
    baselineScore: number | null;
    candidateScore: number | null;
    uncalibrated: boolean;
    probeDelta: number | null;
  };
}

export interface ApplyImprovementResult {
  decision: ImprovementDecision;
  prUrl: string | null;
  prNumber: number | null;
  merged: boolean;
}

function repoOf(key: string): RepoRef {
  const [owner, ...rest] = key.split('/');
  return { owner: owner as string, name: rest.join('/') };
}

function forgeFailure(error: unknown): never {
  if (error instanceof ForgeError) {
    const wrapped = new Error(error.message);
    wrapped.name = 'ForgeError';
    (wrapped as { code?: string }).code = error.code;
    (wrapped as { details?: unknown }).details = error.details;
    throw wrapped;
  }
  throw error;
}

export async function benchmarkEvidenceFor(args: {
  factory: string;
  definitionRoot: string;
  definitionCommit: string;
  authority: ImprovementAuthorityName;
}): Promise<BenchmarkNonRegressionEvidence | null> {
  if (args.authority !== 'auto_merge_on_benchmark') return null;
  const { definition } = loadDefinition(args.definitionRoot);
  if (!definition) return null;

  let suites;
  try {
    suites = loadBenchmarkSuites(definition);
  } catch {
    return null;
  }

  const sql = getSql();
  for (const suite of suites) {
    const configHash = benchmarkConfigHash(suite, args.definitionCommit);
    const attestation = await findBenchmarkAttestation(sql, {
      factory: args.factory,
      definitionCommit: args.definitionCommit,
      configHash,
    });
    if (attestation?.passed && attestation.calibrationOk && !attestation.partial) {
      return {
        attestationPassed: attestation.passed,
        attestationCalibrated: attestation.calibrationOk,
        commitMatches: attestation.definitionCommit === args.definitionCommit,
        configHash,
      };
    }
  }
  return {
    attestationPassed: false,
    attestationCalibrated: false,
    commitMatches: false,
    configHash: null,
  };
}

function prBody(args: ApplyImprovementArgs, decision: ImprovementDecision): string {
  const evidence = args.proposal.evidence as {
    runIds?: string[];
    failedRuns?: number;
    totalRuns?: number;
    scorerRationales?: { scorer: string; rationale: string }[];
  };
  return [
    `# ${args.proposal.title}`,
    '',
    args.proposal.summary,
    '',
    `- Failure signature: \`${args.proposal.failureSignature}\``,
    `- Evidence: ${evidence.failedRuns ?? '?'} failed run(s) of ${evidence.totalRuns ?? '?'} (${(evidence.runIds ?? []).join(', ') || 'none'})`,
    `- Impact: ${args.proposal.impact}`,
    `- Authority: \`${args.authority}\` → \`${decision.code}\``,
    `- Probe delta: ${args.probe.probeDelta ?? 'none'}`,
    `- Candidate hash: \`${args.candidateHash}\``,
    '',
    '## Files',
    ...args.diff.map((entry) => `- \`${entry.path}\``),
    '',
    '## Rationale',
    ...(evidence.scorerRationales ?? []).map((entry) => `- ${entry.scorer}: ${entry.rationale}`),
    '',
    decision.reason,
  ].join('\n');
}

export async function applyImprovementDecision(
  args: ApplyImprovementArgs,
): Promise<ApplyImprovementResult> {
  const benchmark = await benchmarkEvidenceFor({
    factory: args.factory,
    definitionRoot: args.factoryRoot,
    definitionCommit: args.definitionCommit,
    authority: args.authority,
  });

  const decision = decideImprovement({
    authority: args.authority,
    hasCandidate: true,
    probe: {
      baselineScore: args.probe.baselineScore,
      candidateScore: args.probe.candidateScore,
      uncalibrated: args.probe.uncalibrated,
    },
    benchmark,
  });

  if (decision.action !== 'open_pr' && decision.action !== 'merge') {
    return { decision, prUrl: null, prNumber: null, merged: false };
  }

  const { definition } = loadDefinition(args.factoryRoot);
  if (!definition) {
    const error = new Error(`factory "${args.factory}" does not validate`);
    (error as { code?: string }).code = 'definition_invalid';
    throw error;
  }

  const repo = repoOf(args.definitionRepo);
  const forge = getForge();
  const baselineFiles = Object.fromEntries(
    serializeDefinition(definition).map((file) => [file.path, file.content]),
  );
  if (forge instanceof FakeForge) forge.seedRepo(repo, baselineFiles);

  const branch = `improvement/${args.proposal.id}`;
  try {
    await forge.createBranch({
      repo,
      name: branch,
      ...(args.baseBranch ? { from: args.baseBranch } : {}),
    });
    const files: FileChange[] = args.diff.map((entry) => ({
      path: entry.path,
      content: entry.after,
    }));
    await forge.commit({
      repo,
      branch,
      message: `factory: improvement ${args.proposal.failureSignature}`,
      files,
    });
    const pull = await forge.openPullRequest({
      repo,
      head: branch,
      ...(args.baseBranch ? { base: args.baseBranch } : {}),
      title: `Improvement: ${args.proposal.title}`,
      body: prBody(args, decision),
    });

    let merged = false;
    if (decision.action === 'merge') {
      const result = await forge.merge({ repo, pullRequestNumber: pull.number });
      merged = result.merged;
    }

    return { decision, prUrl: pull.url, prNumber: pull.number, merged };
  } catch (error) {
    return forgeFailure(error);
  }
}
