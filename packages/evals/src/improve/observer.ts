import {
  canonicalMarkdown,
  canonicalYaml,
  type FactoryDefinition,
  type Resource,
} from '@factory/core';
import { loadScorerRegistry } from '../registry';
import type {
  ObservedEdit,
  ObservedEvidence,
  ObservedProposal,
  ScoredRunEvidence,
  ScoreEvidence,
} from './types';

/**
 * Deterministic observer (Harness² Loop 1, spec `self-improvement` › Evidence).
 *
 * It reads the scored corpus — no model, no network — and turns failures into file-scoped
 * edits: an *invariant* edit to the agent prompt (a general guardrail) and a *domain* edit
 * to the scorer rubric or skill (the repo-specific correction). Each proposal records the
 * source run ids, failure counts, scorer rationales and an impact score derived from failed
 * runs and their cost. The hook is deterministic so tests and smoke never need credentials;
 * a production observer can replace it behind the same shape.
 */

export interface ObserverOptions {
  /** Optional cap on the number of proposals returned. */
  maxProposals?: number;
}

interface FailureSignal {
  signature: string;
  scorer: string | null;
  rationale: string | null;
}

/** Failed runs × (1 + cost); deterministic and monotone, used only for ranking. */
export function computeImpact(args: {
  failedRuns: number;
  costUsd: number;
  failureCount: number;
}): number {
  const cost = Math.max(0, args.costUsd);
  return Math.round(args.failedRuns * (1 + cost) * (1 + args.failureCount / 10) * 1_000) / 1_000;
}

export function failureSignalsOf(run: ScoredRunEvidence): FailureSignal[] {
  const signals: FailureSignal[] = [];
  if (run.status !== 'ok') {
    signals.push({ signature: `run:${run.status}`, scorer: null, rationale: null });
  }
  for (const score of run.scores) {
    if (score.status === 'error') {
      signals.push({
        signature: `${score.scorer}:${score.errorCode ?? 'error'}`,
        scorer: score.scorer,
        rationale: score.rationale,
      });
    } else if (score.status === 'ok' && !score.passing) {
      signals.push({
        signature: `${score.scorer}:${score.label ?? 'failed'}`,
        scorer: score.scorer,
        rationale: score.rationale,
      });
    }
  }
  return signals;
}

function byPath(resources: Resource[], kind: Resource['kind'], name: string | null): Resource | null {
  if (!name) return null;
  return resources.find((resource) => resource.kind === kind && resource.name === name) ?? null;
}

function targetAgent(
  definition: FactoryDefinition,
  scorer: string | null,
  stage: string | null,
): Resource | null {
  const agents = definition.resources.filter((resource) => resource.kind === 'agent');
  if (agents.length === 0) return null;

  if (scorer) {
    const registry = loadScorerRegistry(definition);
    const entry = registry.find((candidate) => candidate.name === scorer);
    const preferred = entry?.agents[0];
    if (preferred) {
      const found = byPath(agents, 'agent', preferred);
      if (found) return found;
    }
  }

  if (stage) {
    const byRole = agents.find(
      (resource) => (resource.doc as { role?: string }).role === stage,
    );
    if (byRole) return byRole;
  }

  return byPath(agents, 'agent', 'implement') ?? agents[0] ?? null;
}

function targetDomain(
  definition: FactoryDefinition,
  scorer: string | null,
): Resource | null {
  if (scorer) {
    const found = byPath(definition.resources, 'scorer', scorer);
    if (found) return found;
  }
  return definition.resources.find((resource) => resource.kind === 'skill') ?? null;
}

function withMarker(body: string, marker: string): boolean {
  return body.includes(marker);
}

function appendBody(resource: Resource, addition: string): string {
  const body = `${resource.body}\n\n${addition}`;
  return resource.format === 'markdown'
    ? canonicalMarkdown(resource.doc, body)
    : canonicalYaml(resource.doc);
}

const MAX_ADDITION_CHARS = 600;

function invariantAddition(signature: string): string {
  return [
    `## Improvement guardrail: ${signature}`,
    '',
    `When a run ends as \`${signature}\`, reproduce it before finishing and fix the root cause.`,
    'Leave the repository checks green and do not widen scope to compensate.',
  ].join('\n').slice(0, MAX_ADDITION_CHARS);
}

function domainAddition(resource: Resource, signature: string): string {
  if (resource.kind === 'scorer') {
    return [
      `Treat \`${signature}\` as a failure of this rubric.`,
      'When the failure signature appears in the run evidence, grade below the passing score and',
      'cite the exact artifact or event that shows it.',
    ].join('\n').slice(0, MAX_ADDITION_CHARS);
  }
  return [
    `- When the failure signature \`${signature}\` appears, stop and fix the root cause`,
    '  before continuing; record the check you ran.',
  ].join('\n').slice(0, MAX_ADDITION_CHARS);
}

interface Cluster {
  signature: string;
  scorer: string | null;
  stage: string | null;
  runIds: Set<string>;
  failureCount: number;
  costUsd: number;
  rationales: Map<string, string>;
  totalRuns: number;
}

function evidenceOf(cluster: Cluster): ObservedEvidence {
  const runIds = [...cluster.runIds].sort();
  return {
    runIds,
    failedRuns: runIds.length,
    totalRuns: cluster.totalRuns,
    failureCount: cluster.failureCount,
    costUsd: Math.round(cluster.costUsd * 1_000_000) / 1_000_000,
    scorerRationales: [...cluster.rationales.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([scorer, rationale]) => ({ scorer, rationale })),
  };
}

/**
 * Turns the scored corpus into ranked, evidence-backed proposals. One proposal per
 * failure signature; each carries at most one invariant and one domain edit.
 */
export function observeScoredCorpus(
  definition: FactoryDefinition,
  corpus: ScoredRunEvidence[],
  options: ObserverOptions = {},
): ObservedProposal[] {
  const clusters = new Map<string, Cluster>();
  const totalRuns = corpus.length;

  for (const run of corpus) {
    for (const signal of failureSignalsOf(run)) {
      const cluster = clusters.get(signal.signature) ?? {
        signature: signal.signature,
        scorer: signal.scorer,
        stage: run.stage,
        runIds: new Set<string>(),
        failureCount: 0,
        costUsd: 0,
        rationales: new Map<string, string>(),
        totalRuns,
      };
      cluster.runIds.add(run.runId);
      cluster.failureCount += 1;
      cluster.costUsd += run.costUsd;
      if (signal.scorer && signal.rationale) {
        cluster.rationales.set(signal.scorer, signal.rationale);
      }
      clusters.set(signal.signature, cluster);
    }
  }

  const proposals: ObservedProposal[] = [];

  for (const cluster of clusters.values()) {
    const evidence = evidenceOf(cluster);
    const edits: ObservedEdit[] = [];

    const agent = targetAgent(definition, cluster.scorer, cluster.stage);
    if (agent) {
      const marker = `Improvement guardrail: ${cluster.signature}`;
      if (!withMarker(agent.body, marker)) {
        edits.push({
          kind: 'invariant',
          path: agent.path,
          rationale: `${evidence.failedRuns} failed run(s) show ${cluster.signature}; make the agent reproduce and fix it before finishing.`,
          content: appendBody(agent, invariantAddition(cluster.signature)),
        });
      }
    }

    const domain = targetDomain(definition, cluster.scorer);
    if (domain) {
      const marker = `Treat \`${cluster.signature}\` as a failure`;
      if (!withMarker(domain.body, marker)) {
        edits.push({
          kind: 'domain',
          path: domain.path,
          rationale: `Encode ${cluster.signature} in ${domain.kind} "${domain.name}" so the same work is graded the same way next time.`,
          content: appendBody(domain, domainAddition(domain, cluster.signature)),
        });
      }
    }

    if (edits.length === 0) continue;

    proposals.push({
      title: `Fix ${cluster.signature}`,
      summary: `${evidence.failedRuns} of ${totalRuns} scored run(s) failed with ${cluster.signature}. Proposed ${edits.length} edit(s) in ${[...new Set(edits.map((edit) => edit.path))].join(', ')}.`,
      failureSignature: cluster.signature,
      files: [...new Set(edits.map((edit) => edit.path))].sort(),
      edits,
      evidence,
      impact: computeImpact({
        failedRuns: evidence.failedRuns,
        costUsd: evidence.costUsd,
        failureCount: evidence.failureCount,
      }),
    });
  }

  const ranked = rankProposals(proposals);
  return options.maxProposals ? ranked.slice(0, Math.max(1, options.maxProposals)) : ranked;
}

/** Highest impact first; signature breaks ties so the order is deterministic. */
export function rankProposals<T extends { impact: number; failureSignature: string }>(
  proposals: T[],
): T[] {
  return [...proposals].sort((left, right) => {
    if (right.impact !== left.impact) return right.impact - left.impact;
    return left.failureSignature < right.failureSignature ? -1 : 1;
  });
}

/** Dedupe key: the same files plus the same root-cause signature is one item. */
export function clusterKeyOf(proposal: Pick<ObservedProposal, 'files' | 'failureSignature'>): string {
  return `${[...proposal.files].sort().join(',')}#${proposal.failureSignature}`;
}

/**
 * Merges proposals that share files + failure signature into one ranked item with a
 * combined evidence set (spec `self-improvement` › Dedupe).
 */
export function dedupeProposals(proposals: ObservedProposal[]): ObservedProposal[] {
  const merged = new Map<string, ObservedProposal>();

  for (const proposal of proposals) {
    const key = clusterKeyOf(proposal);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...proposal,
        files: [...proposal.files],
        edits: [...proposal.edits],
        evidence: { ...proposal.evidence, runIds: [...proposal.evidence.runIds] },
      });
      continue;
    }

    const runIds = [...new Set([...existing.evidence.runIds, ...proposal.evidence.runIds])].sort();
    const rationales = new Map<string, string>();
    for (const entry of [...existing.evidence.scorerRationales, ...proposal.evidence.scorerRationales]) {
      rationales.set(entry.scorer, entry.rationale);
    }

    const evidence: ObservedEvidence = {
      runIds,
      failedRuns: runIds.length,
      totalRuns: Math.max(existing.evidence.totalRuns, proposal.evidence.totalRuns),
      failureCount: existing.evidence.failureCount + proposal.evidence.failureCount,
      costUsd: existing.evidence.costUsd + proposal.evidence.costUsd,
      scorerRationales: [...rationales.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([scorer, rationale]) => ({ scorer, rationale })),
    };

    const editKeys = new Set(existing.edits.map((edit) => `${edit.kind}\u0000${edit.path}`));
    const edits = [...existing.edits];
    for (const edit of proposal.edits) {
      const editKey = `${edit.kind}\u0000${edit.path}`;
      if (!editKeys.has(editKey)) {
        editKeys.add(editKey);
        edits.push(edit);
      }
    }

    merged.set(key, {
      ...existing,
      title: proposal.impact > existing.impact ? proposal.title : existing.title,
      summary: `${evidence.failedRuns} of ${evidence.totalRuns} scored run(s) failed with ${existing.failureSignature}.`,
      files: [...new Set([...existing.files, ...proposal.files])].sort(),
      edits,
      evidence,
      impact: computeImpact({
        failedRuns: evidence.failedRuns,
        costUsd: evidence.costUsd,
        failureCount: evidence.failureCount,
      }),
    });
  }

  return rankProposals([...merged.values()]);
}

/** Convenience for callers that only have raw scores: failing scores on one run. */
export function failingScores(run: ScoredRunEvidence): ScoreEvidence[] {
  return run.scores.filter(
    (score) => score.status === 'error' || (score.status === 'ok' && !score.passing),
  );
}
