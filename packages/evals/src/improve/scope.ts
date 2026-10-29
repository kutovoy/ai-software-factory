import type { ObservedEdit } from './types';

/**
 * Blast-radius guard (spec `self-improvement` › Blast radius).
 *
 * An observer may edit agent instructions, skills, model routing, scorer rubrics and
 * automation triggers. Everything else — gates, mergePolicy (both live in `factory.yaml`),
 * runners, benchmarks, packs and the factory's own source — is rejected with
 * `edit_out_of_scope`, and the attempt is recorded.
 */

export const EDIT_OUT_OF_SCOPE = 'edit_out_of_scope';

const AGENT_PROMPT_RE = /^agents\/[^/]+\/agent\.md$/;
const SKILL_RE = /^(skills\/[^/]+\/SKILL\.md|skills\/[^/]+\.md)$/;
const AGENT_SKILL_RE = /^agents\/[^/]+\/skills\/[^/]+\/SKILL\.md$/;
const SCORER_RE = /^(scorers\/[^/]+\/scorer\.md|scorers\/[^/]+\.md)$/;
const AUTOMATION_RE = /^(automations\/[^/]+\/automation\.md|automations\/[^/]+\.md)$/;
const ROUTING_RE = /^routing\.yaml$/;

/** Paths that are explicitly forbidden, named for the error details. */
export const FORBIDDEN_PREFIXES = ['runners/', 'benchmarks/', 'gates/', 'src/', 'packs.lock'];

export function isEditInScope(path: string): boolean {
  if (path === 'factory.yaml' || path === 'packs.lock') return false;
  return (
    AGENT_PROMPT_RE.test(path) ||
    SKILL_RE.test(path) ||
    AGENT_SKILL_RE.test(path) ||
    SCORER_RE.test(path) ||
    AUTOMATION_RE.test(path) ||
    ROUTING_RE.test(path)
  );
}

export interface ScopeViolation {
  path: string;
  code: typeof EDIT_OUT_OF_SCOPE;
  message: string;
}

export function scopeViolations(edits: Pick<ObservedEdit, 'path'>[]): ScopeViolation[] {
  return edits
    .filter((edit) => !isEditInScope(edit.path))
    .map((edit) => ({
      path: edit.path,
      code: EDIT_OUT_OF_SCOPE,
      message: `edit to "${edit.path}" is outside the allowed blast radius (agents/*/agent.md, skills/*, routing.yaml, scorers/*, automations/*)`,
    }));
}

export interface GuardedEdits {
  inScope: ObservedEdit[];
  outOfScope: ScopeViolation[];
}

export function guardEdits(edits: ObservedEdit[]): GuardedEdits {
  const violations = scopeViolations(edits);
  const rejected = new Set(violations.map((violation) => violation.path));
  return {
    inScope: edits.filter((edit) => !rejected.has(edit.path)),
    outOfScope: violations,
  };
}

/** Throws when any edit is out of scope; used by the compose path. */
export function assertEditsInScope(edits: Pick<ObservedEdit, 'path'>[]): void {
  const violations = scopeViolations(edits);
  if (violations.length === 0) return;
  const error = new Error(violations.map((violation) => violation.message).join('; '));
  error.name = 'EditScopeError';
  (error as { code?: string }).code = EDIT_OUT_OF_SCOPE;
  (error as { violations?: ScopeViolation[] }).violations = violations;
  throw error;
}
