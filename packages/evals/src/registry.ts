import { createHash } from 'node:crypto';
import type { FactoryDefinition, ScorerDef } from '@factory/core';
import {
  DETERMINISTIC_CHECKS,
  ScorerRegistryError,
  type DeterministicCheck,
  type ScorerLabel,
  type ScorerRegistryEntry,
} from './types';

export { ScorerRegistryError } from './types';

/**
 * Scorer registry.
 *
 * Scorers are declared in the git-backed definition (`scorers/<name>/scorer.md`). This
 * module turns those declarations into registry entries and infers the class:
 *
 *  - a scorer whose rubric body declares a `checks:` block (tests/build/lint) is
 *    `deterministic` — it is graded from run artifacts without a model and always runs;
 *  - everything else is a `judge` scorer, graded against the rubric by an LLM.
 *
 * The rubric is content-addressed: `rubricHash = sha256(body + label set)`. A score keeps
 * the hash it was produced with, so a rubric change is detectable without rewriting
 * history.
 */

const CHECKS_INLINE_RE = /^\s*checks:\s*\[([^\]]*)\]\s*$/m;
const CHECKS_BLOCK_RE = /^\s*checks:\s*$/m;

export function normalizeLabels(labels: ScorerLabel[]): ScorerLabel[] {
  return labels.map((label) => ({
    value: label.value,
    score: label.score,
    ...(label.description === undefined ? {} : { description: label.description }),
  }));
}

/** sha256 over the rubric body and the declared label set (order-sensitive). */
export function rubricHashFor(body: string, labels: ScorerLabel[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ body, labels: normalizeLabels(labels) }))
    .digest('hex');
}

function parseChecks(body: string): DeterministicCheck[] | null {
  const inline = CHECKS_INLINE_RE.exec(body);
  if (inline) {
    const values = inline[1]
      .split(',')
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
      .filter((value) => value.length > 0);
    return validateChecks(values);
  }

  const lines = body.split('\n');
  const start = lines.findIndex((line) => CHECKS_BLOCK_RE.test(line));
  if (start === -1) return null;

  const baseIndent = lines[start]?.match(/^\s*/)?.[0].length ?? 0;
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= baseIndent) break;
    const match = /^\s*-\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (!match) break;
    values.push(match[1] as string);
  }
  return values.length > 0 ? validateChecks(values) : null;
}

function validateChecks(values: string[]): DeterministicCheck[] {
  const allowed = DETERMINISTIC_CHECKS as readonly string[];
  const unknown = values.filter((value) => !allowed.includes(value));
  if (unknown.length > 0) {
    throw new ScorerRegistryError(
      'invalid_scorer_checks',
      `unsupported deterministic check(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`,
      { checks: values, allowed },
    );
  }
  return [...new Set(values)] as DeterministicCheck[];
}

function validateLabels(doc: ScorerDef, name: string): void {
  if (doc.labels.length === 0) {
    throw new ScorerRegistryError('invalid_scorer_labels', `scorer "${name}" declares no labels`);
  }
  const values = doc.labels.map((label) => label.value);
  if (new Set(values).size !== values.length) {
    throw new ScorerRegistryError(
      'invalid_scorer_labels',
      `scorer "${name}" declares duplicate label values`,
      { labels: values },
    );
  }
  const scores = doc.labels.map((label) => label.score);
  if (!scores.some((score) => score >= doc.passingScore)) {
    throw new ScorerRegistryError(
      'invalid_scorer_labels',
      `scorer "${name}": no label scores >= passingScore (${doc.passingScore})`,
    );
  }
  if (!scores.some((score) => score < doc.passingScore)) {
    throw new ScorerRegistryError(
      'invalid_scorer_labels',
      `scorer "${name}": no label scores below passingScore (${doc.passingScore})`,
    );
  }
}

export function registryEntry(resource: {
  name: string;
  path: string;
  doc: unknown;
  body: string;
}): ScorerRegistryEntry {
  const doc = resource.doc as ScorerDef;
  validateLabels(doc, resource.name);
  const checks = parseChecks(resource.body);
  const labels = normalizeLabels(doc.labels as ScorerLabel[]);
  return {
    name: resource.name,
    path: resource.path,
    description: doc.description ?? null,
    body: resource.body,
    scorerClass: checks ? 'deterministic' : 'judge',
    labels,
    passingScore: doc.passingScore,
    samplingRate: doc.samplingRate,
    judgeModel: doc.judgeModel,
    selfImprovement: doc.selfImprovement,
    agents: [...(doc.agents ?? [])],
    checks: checks ?? [],
    rubricHash: rubricHashFor(resource.body, labels),
  };
}

/** Loads every scorer from a validated definition, sorted by name. */
export function loadScorerRegistry(definition: FactoryDefinition): ScorerRegistryEntry[] {
  return definition.resources
    .filter((resource) => resource.kind === 'scorer')
    .map((resource) =>
      registryEntry({
        name: resource.name,
        path: resource.path,
        doc: resource.doc,
        body: resource.body,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findScorer(
  registry: ScorerRegistryEntry[],
  name: string,
): ScorerRegistryEntry | null {
  return registry.find((entry) => entry.name === name) ?? null;
}

export function highestLabel(scorer: ScorerRegistryEntry): ScorerLabel {
  return [...scorer.labels].sort((left, right) => right.score - left.score)[0] as ScorerLabel;
}

export function lowestLabel(scorer: ScorerRegistryEntry): ScorerLabel {
  return [...scorer.labels].sort((left, right) => left.score - right.score)[0] as ScorerLabel;
}
