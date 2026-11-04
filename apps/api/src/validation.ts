import {
  evaluateValidationContract,
  validationContractSchema,
  validationEvidenceSchema,
  type ForgeCheck,
  type ValidationEvidence,
  type ValidationProjection,
  type WorkItem,
  type WorkItemEvent,
} from '@factory/core';
import { validationIncomplete } from './errors';

/**
 * Validation-contract projection (spec `validation-contract`, roadmap item 1).
 *
 * The contract is persisted in `work_items.input.validationContract` at creation. Evidence
 * arrives from two append-only sources: the verify agent's `validation.evidence` event and
 * the forge's newest `checks.recorded` event. Everything here is a pure read of the read
 * model — no model call, no shell.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses the agent evidence array; malformed entries are dropped, never guessed. */
function parseEvidence(payload: Record<string, unknown> | undefined): ValidationEvidence[] {
  const raw = payload?.checks;
  if (!Array.isArray(raw)) return [];
  const evidence: ValidationEvidence[] = [];
  for (const entry of raw) {
    const parsed = validationEvidenceSchema.safeParse(entry);
    if (parsed.success) evidence.push(parsed.data);
  }
  return evidence;
}

/** Parses forge check runs (`{name, conclusion, status}`); unknown shapes are dropped. */
function parseForgeChecks(payload: Record<string, unknown> | undefined): ForgeCheck[] {
  const raw = payload?.checks;
  if (!Array.isArray(raw)) return [];
  const checks: ForgeCheck[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = record.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const conclusion = typeof record.conclusion === 'string' ? record.conclusion : undefined;
    const status = typeof record.status === 'string' ? record.status : undefined;
    checks.push({
      name,
      ...(conclusion !== undefined ? { conclusion } : {}),
      ...(status !== undefined ? { status } : {}),
    });
  }
  return checks;
}

/** Newest event of `type` from the chronological event list. */
function newestEvent(events: WorkItemEvent[], type: string): WorkItemEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) return events[index];
  }
  return null;
}

/**
 * Projects the persisted contract against the recorded evidence. Returns `null` when the
 * item carries no contract or the persisted value does not validate (e.g. written by an
 * older definition).
 */
export function projectValidation(
  item: WorkItem,
  events: WorkItemEvent[],
): ValidationProjection | null {
  const raw = item.input.validationContract;
  if (raw === undefined) return null;
  const parsed = validationContractSchema.safeParse(raw);
  if (!parsed.success) return null;

  const evidenceEvent = newestEvent(events, 'validation.evidence');
  const evidence = parseEvidence(evidenceEvent?.payload);

  const checksEvent = newestEvent(events, 'checks.recorded');
  const forgeChecks = parseForgeChecks(checksEvent?.payload);

  return evaluateValidationContract(parsed.data, evidence, forgeChecks);
}

/**
 * Refuses a verify-gate approval while the contract is enforced and required evidence is
 * missing. A projection-less item and an advisory (`enforce: false`) contract never block.
 */
export function assertValidationComplete(item: WorkItem, events: WorkItemEvent[]): void {
  const projection = projectValidation(item, events);
  if (!projection) return;
  if (projection.contract.enforce && !projection.complete) {
    throw validationIncomplete(item.id, projection.missing);
  }
}
