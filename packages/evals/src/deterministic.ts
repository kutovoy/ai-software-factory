import { highestLabel, lowestLabel } from './registry';
import {
  DETERMINISTIC_CHECKS,
  type DeterministicCheck,
  type RunEvidence,
  type ScorerRegistryEntry,
  type ScoreEvidenceRef,
} from './types';

/**
 * Deterministic scoring: tests / build / lint, read from run artifacts or from the
 * canonical event log. No model, no network, no credentials — and it always runs.
 *
 * Evidence precedence:
 *  1. `artifacts/checks.json` (or `checks.json`) written by the runner;
 *  2. the last matching `tool.call.completed` for a bash/exec command.
 *
 * A required check with no evidence at all is `error` with code `missing_artifact`; the
 * run itself is untouched.
 */

const CHECK_PATTERNS: Record<DeterministicCheck, RegExp> = {
  tests:
    /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|go\s+test|cargo\s+test|bun\s+test)\b/i,
  build:
    /\b(?:bun|npm|pnpm|yarn)\s+run\s+build\b|\b(?:tsc|vite\s+build|next\s+build|go\s+build|cargo\s+build|make)\b/i,
  lint: /\b(?:eslint|biome|ruff|golangci-lint)\b|\b(?:bun|npm|pnpm|yarn)\s+run\s+lint\b/i,
};

export interface DeterministicCheckResult {
  check: DeterministicCheck;
  ok: boolean;
  ref: string;
}

export interface DeterministicOutcome {
  status: 'ok' | 'error';
  errorCode: 'missing_artifact' | null;
  label: string | null;
  score: number | null;
  passing: boolean;
  rationale: string;
  evidenceRefs: string[];
  evidence: ScoreEvidenceRef[];
  checks: DeterministicCheckResult[];
  missing: DeterministicCheck[];
}

export function checkForCommand(command: string | undefined): DeterministicCheck | null {
  if (!command) return null;
  for (const check of DETERMINISTIC_CHECKS) {
    if (CHECK_PATTERNS[check].test(command)) return check;
  }
  return null;
}

function readChecksArtifact(
  evidence: RunEvidence,
): Partial<Record<DeterministicCheck, boolean>> | null {
  const body =
    evidence.artifactContents['artifacts/checks.json'] ?? evidence.artifactContents['checks.json'];
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const result: Partial<Record<DeterministicCheck, boolean>> = {};
    for (const check of DETERMINISTIC_CHECKS) {
      const value = parsed[check];
      if (typeof value === 'boolean') result[check] = value;
      else if (value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean') {
        result[check] = (value as { ok: boolean }).ok;
      }
    }
    return result;
  } catch {
    return null;
  }
}

function checkFromEvents(
  evidence: RunEvidence,
  check: DeterministicCheck,
): { ok: boolean; seq: number } | null {
  let latest: { ok: boolean; seq: number } | null = null;
  for (const call of evidence.toolCalls) {
    if (checkForCommand(call.command) !== check) continue;
    if (latest === null || call.seq > latest.seq) latest = { ok: call.ok, seq: call.seq };
  }
  return latest;
}

export function evaluateDeterministic(
  scorer: ScorerRegistryEntry,
  evidence: RunEvidence,
): DeterministicOutcome {
  const artifact = readChecksArtifact(evidence);
  const results: DeterministicCheckResult[] = [];
  const missing: DeterministicCheck[] = [];
  const refs: ScoreEvidenceRef[] = [];

  for (const check of scorer.checks) {
    const fromArtifact = artifact?.[check];
    if (typeof fromArtifact === 'boolean') {
      results.push({ check, ok: fromArtifact, ref: 'artifact:checks.json' });
      refs.push({
        kind: 'artifact',
        ref: 'artifact:checks.json',
        detail: { check, ok: fromArtifact },
      });
      continue;
    }

    const fromEvent = checkFromEvents(evidence, check);
    if (fromEvent) {
      results.push({ check, ok: fromEvent.ok, ref: `event:${fromEvent.seq}` });
      refs.push({
        kind: 'event',
        ref: `event:${fromEvent.seq}`,
        detail: { check, ok: fromEvent.ok },
      });
      continue;
    }

    missing.push(check);
  }

  if (missing.length > 0) {
    return {
      status: 'error',
      errorCode: 'missing_artifact',
      label: null,
      score: null,
      passing: false,
      rationale: `missing_artifact: no evidence for ${missing.join(', ')}`,
      evidenceRefs: refs.map((ref) => ref.ref),
      evidence: refs,
      checks: results,
      missing,
    };
  }

  const allPassed = results.every((result) => result.ok);
  const label = allPassed ? highestLabel(scorer) : lowestLabel(scorer);
  const score = label.score;
  const passing = score >= scorer.passingScore;
  const summary = results
    .map((result) => `${result.check}: ${result.ok ? 'pass' : 'fail'}`)
    .join(', ');

  return {
    status: 'ok',
    errorCode: null,
    label: label.value,
    score,
    passing,
    rationale: `deterministic checks — ${summary}`,
    evidenceRefs: refs.map((ref) => ref.ref),
    evidence: refs,
    checks: results,
    missing: [],
  };
}
