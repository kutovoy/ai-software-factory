import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_QUALITY_STANDARDS,
  DEFAULT_SLOP_BUDGETS,
  type ReviewPacket,
} from '@factory/core';
import { standardsBlockGate, standardsOverageFeedback } from '../src/workflows/stage';

function packet(standards: Partial<ReviewPacket['standards']> = {}): ReviewPacket {
  return {
    riskTier: 'high',
    intent: 'add a public endpoint',
    planRef: null,
    changedFiles: 2,
    diffStats: { additions: 10, deletions: 0 },
    assertions: [],
    architectureImpact: [],
    openQuestions: [],
    reviewerChecklist: [],
    slopBudget: DEFAULT_SLOP_BUDGETS.high,
    slopActual: {
      changedFiles: 2,
      additions: 10,
      deletions: 0,
      diffLines: 10,
      newDependencies: 0,
      duplicationDeltaPercent: null,
      complexityDelta: null,
    },
    slopStatus: 'pass',
    blastRadius: {
      paths: ['src/api/users.ts', 'db/schema.sql'],
      highRiskPaths: [],
      publicApiChanges: 1,
      schemaChanges: 1,
    },
    standards: {
      maxPublicApiChanges: DEFAULT_QUALITY_STANDARDS.maxPublicApiChanges,
      maxSchemaChanges: DEFAULT_QUALITY_STANDARDS.maxSchemaChanges,
      publicApiChanges: 0,
      schemaChanges: 0,
      status: 'pass',
      ...standards,
    },
    proofArtifacts: [],
    readFirst: [],
    decisions: [],
    reviewerRoles: ['correctness'],
    comprehension: { estimatedReadMinutes: 1, filesWithoutTests: 1, modulesWithoutOwner: 0 },
    contextPackRef: null,
  };
}

describe('standards gate', () => {
  test('an exceeded packet blocks the agent gate (request_changes)', () => {
    const exceeded = packet({
      publicApiChanges: 6,
      schemaChanges: 4,
      status: 'exceeded',
    });
    expect(standardsBlockGate(exceeded)).toBe(true);
    expect(standardsOverageFeedback(exceeded)).toBe(
      'standards exceeded: public API changes 6 > 5; schema changes 4 > 3',
    );
  });

  test('only the exceeded cap is named in the feedback', () => {
    const schemaOnly = packet({ schemaChanges: 4, status: 'exceeded' });
    expect(standardsOverageFeedback(schemaOnly)).toBe('standards exceeded: schema changes 4 > 3');
  });

  test('a passing or missing packet never blocks the gate', () => {
    expect(standardsBlockGate(packet())).toBe(false);
    expect(standardsBlockGate(null)).toBe(false);
  });
});
