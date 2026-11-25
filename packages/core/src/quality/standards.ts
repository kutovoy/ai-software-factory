import {
  DEFAULT_QUALITY_STANDARDS,
  type QualityStandards,
  type StandardsStatus,
} from './types';

/**
 * Standards guard: public-API/schema blast-radius caps (change
 * `add-risk-aware-routing-and-standards`).
 *
 * Pure data in, deterministic status out: no model, no shell, no Node APIs. The review
 * packet feeds measured counts in; this module resolves caps and reports whether a change
 * exceeds them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pickCount(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Merges an optional/partial standards config with the shipped defaults. Accepts both a
 * bare `QualityStandards` and a full `QualityConfig` (`{ standards: {...} }`).
 */
export function resolveQualityStandards(value: unknown | null | undefined): QualityStandards {
  const source = isRecord(value) ? value : {};
  const caps = isRecord(source.standards) ? source.standards : source;
  return {
    maxPublicApiChanges: pickCount(
      caps.maxPublicApiChanges,
      DEFAULT_QUALITY_STANDARDS.maxPublicApiChanges,
    ),
    maxSchemaChanges: pickCount(caps.maxSchemaChanges, DEFAULT_QUALITY_STANDARDS.maxSchemaChanges),
    requireMigrationForSchemaChange:
      typeof caps.requireMigrationForSchemaChange === 'boolean'
        ? caps.requireMigrationForSchemaChange
        : DEFAULT_QUALITY_STANDARDS.requireMigrationForSchemaChange,
  };
}

/**
 * Compares measured public-API/schema counts with the resolved caps. A metric above its cap
 * makes the change `exceeded`; equal to the cap still passes. Negative/non-finite input is
 * treated as zero (never as an overage).
 */
export function evaluateStandards(
  input: { publicApiChanges: number; schemaChanges: number },
  config: QualityStandards,
): StandardsStatus {
  const publicApiChanges = pickCount(input.publicApiChanges, 0);
  const schemaChanges = pickCount(input.schemaChanges, 0);
  const exceeded =
    publicApiChanges > config.maxPublicApiChanges || schemaChanges > config.maxSchemaChanges;
  return {
    maxPublicApiChanges: config.maxPublicApiChanges,
    maxSchemaChanges: config.maxSchemaChanges,
    publicApiChanges,
    schemaChanges,
    status: exceeded ? 'exceeded' : 'pass',
  };
}
