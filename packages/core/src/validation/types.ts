/**
 * Validation contract types (roadmap item 1).
 *
 * This module is deliberately dependency-free: no Node APIs, no zod, no imports at all.
 * Orchestration workflows import it directly (see the `./validation/types` export in
 * `package.json`), so it must stay safe for the Temporal/workflow sandbox.
 */

export const VALIDATION_TIERS = ['unit', 'component', 'integration', 'e2e', 'manual'] as const;
export type ValidationTier = (typeof VALIDATION_TIERS)[number];

export const VALIDATION_EVIDENCE_SOURCES = ['agent', 'forge', 'human', 'artifact'] as const;
export type ValidationEvidenceSource = (typeof VALIDATION_EVIDENCE_SOURCES)[number];

export const VALIDATION_CHECK_STATUSES = ['pass', 'fail', 'missing'] as const;
export type ValidationCheckStatus = (typeof VALIDATION_CHECK_STATUSES)[number];

/** How a check is expected to produce evidence. */
export type ValidationEvidenceKind = 'command' | 'artifact' | 'forge-check' | 'manual';

export interface ValidationCheck {
  id: string;
  title: string;
  tier: ValidationTier;
  required: boolean;
  evidence: ValidationEvidenceKind;
  command?: string;
  expected?: string;
}

export interface ValidationConfig {
  enabled?: boolean;
  enforce?: boolean;
  tiers?: ValidationTier[];
  checks?: ValidationCheck[];
}

export interface ValidationContract {
  version: 'v1alpha1';
  workItemId: string;
  factory: string;
  definitionCommit: string;
  createdAt: string;
  enforce: boolean;
  checks: ValidationCheck[];
  risks: string[];
  source: 'factory' | 'inferred' | 'work-item';
}

export interface ValidationEvidence {
  checkId: string;
  status: 'pass' | 'fail';
  source: ValidationEvidenceSource;
  detail?: string;
  at?: string;
}

export interface ValidationCheckResult {
  check: ValidationCheck;
  status: ValidationCheckStatus;
  source: ValidationEvidenceSource | null;
  evidence?: ValidationEvidence;
}

export interface ValidationProjection {
  contract: ValidationContract;
  checks: ValidationCheckResult[];
  complete: boolean;
  missing: string[];
}

/** A forge check result (GitHub check run, GitLab pipeline status, ...). */
export interface ForgeCheck {
  name: string;
  conclusion?: string;
  status?: string;
}

/**
 * Appended to the verify stage's prompt when a contract is enforced. The agent finishes
 * with a fenced JSON block so the workflow can parse it without trusting prose.
 */
export const VALIDATION_EVIDENCE_INSTRUCTION = [
  'Before you finish, report validation evidence for every check in the validation contract.',
  'Finish your reply with exactly one fenced JSON block in this shape (no text after it):',
  '```json',
  '{"validation":[{"id":"<check id>","status":"pass|fail","evidence":"<command/output/artifact>"}]}',
  '```',
  'Use the check id verbatim. Report "fail" when a check did not pass; never omit a check you ran.',
].join('\n');

const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toEvidence(entry: unknown): ValidationEvidence | null {
  if (!isRecord(entry)) return null;
  const id = entry.id;
  const status = entry.status;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (status !== 'pass' && status !== 'fail') return null;
  const detail =
    typeof entry.evidence === 'string'
      ? entry.evidence
      : typeof entry.detail === 'string'
        ? entry.detail
        : undefined;
  const at = typeof entry.at === 'string' ? entry.at : undefined;
  return {
    checkId: id,
    status,
    source: 'agent',
    ...(detail !== undefined ? { detail } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

/**
 * Parses the last fenced ```json block that contains a `validation` array. Malformed
 * entries are ignored; a malformed block falls through to the previous one.
 */
export function parseValidationEvidence(text: string): ValidationEvidence[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const blocks: string[] = [];
  FENCED_JSON_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCED_JSON_RE.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(blocks[index]);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.validation)) continue;
    const evidence: ValidationEvidence[] = [];
    for (const entry of parsed.validation) {
      const mapped = toEvidence(entry);
      if (mapped) evidence.push(mapped);
    }
    return evidence;
  }
  return [];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function forgeStatus(check: ForgeCheck): 'pass' | 'fail' | null {
  const value = check.conclusion ?? check.status;
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = normalize(value);
  return normalized === 'success' || normalized === 'skipped' ? 'pass' : 'fail';
}

/**
 * Evaluates a contract against agent evidence and forge check results.
 *
 * Explicit evidence wins by check id. Otherwise a forge check whose lowercased name
 * matches the check id or title is used (`success`/`skipped` pass, anything else fails).
 * A required check that is not passing makes the projection incomplete and is listed in
 * `missing`.
 */
export function evaluateValidationContract(
  contract: ValidationContract,
  evidence: ValidationEvidence[],
  forgeChecks: ForgeCheck[] = [],
): ValidationProjection {
  const explicit = new Map<string, ValidationEvidence>();
  for (const item of evidence) explicit.set(item.checkId, item);

  const checks: ValidationCheckResult[] = contract.checks.map((check) => {
    const agentEvidence = explicit.get(check.id);
    if (agentEvidence) {
      return {
        check,
        status: agentEvidence.status,
        source: agentEvidence.source,
        evidence: agentEvidence,
      };
    }

    const forge = forgeChecks.find(
      (candidate) =>
        normalize(candidate.name) === normalize(check.id) ||
        normalize(candidate.name) === normalize(check.title),
    );
    if (forge) {
      const status = forgeStatus(forge);
      if (status !== null) {
        return { check, status, source: 'forge' };
      }
    }

    return { check, status: 'missing', source: null };
  });

  const missing = checks
    .filter((result) => result.check.required && result.status !== 'pass')
    .map((result) => result.check.id);

  return {
    contract,
    checks,
    complete: missing.length === 0,
    missing,
  };
}
