import { describe, expect, it } from 'bun:test';
import {
  WORK_ITEM_ID_RE,
  autonomyRequestSchema,
  createWorkItemSchema,
  gateDecisionRequestSchema,
  newUlid,
  newWorkItemId,
  workItemSchema,
} from '../src/index';

describe('work item schema', () => {
  const base = {
    id: newWorkItemId(),
    type: 'task',
    source: 'manual',
    sourceRef: { kind: 'issue', id: '123', url: 'https://forge.local/acme/api/issues/123' },
    title: 'Add retry to the API client',
    stage: 'triage',
    parentId: null,
    factory: 'example',
    definitionCommit: 'a1b2c3d4',
  };

  it('accepts a work item with the required fields', () => {
    const parsed = workItemSchema.parse(base);
    expect(parsed.status).toBe('active');
    expect(parsed.loopCount).toBe(0);
    expect(parsed.prUrl).toBeNull();
    expect(parsed.sourceRef.kind).toBe('issue');
  });

  it('requires a wi_<ulid> id', () => {
    expect(() => workItemSchema.parse({ ...base, id: 'wi_123' })).toThrow();
    expect(() => workItemSchema.parse({ ...base, id: 'run_ABC' })).toThrow();
  });

  it('rejects an unknown stage', () => {
    expect(() => workItemSchema.parse({ ...base, stage: 'deploy' })).toThrow();
  });

  it('records lineage through parentId', () => {
    const parent = newWorkItemId();
    expect(workItemSchema.parse({ ...base, parentId: parent }).parentId).toBe(parent);
    expect(() => workItemSchema.parse({ ...base, parentId: 'parent-1' })).toThrow();
  });

  it('rejects unknown fields (strict schema)', () => {
    expect(() => workItemSchema.parse({ ...base, priority: 'high' })).toThrow();
  });

  it('creation input defaults type/source to task/manual', () => {
    const parsed = createWorkItemSchema.parse({
      factory: 'example',
      title: 'something',
      definitionCommit: 'a1b2c3d4',
    });
    expect(parsed.type).toBe('task');
    expect(parsed.source).toBe('manual');
    expect(parsed.stage).toBeUndefined();
  });
});

describe('work item ids', () => {
  it('mints a ULID with a 26-character Crockford body', () => {
    const id = newWorkItemId(1_700_000_000_000);
    expect(id).toMatch(WORK_ITEM_ID_RE);
    expect(id.slice(3)).toHaveLength(26);
    // Crockford base32 excludes I, L, O and U.
    expect(id.slice(3)).not.toMatch(/[ILOU]/);
  });

  it('is unique and ordered by time prefix', () => {
    const early = newWorkItemId(1_700_000_000_000);
    const later = newWorkItemId(1_700_000_001_000);
    expect(early).not.toBe(later);
    expect(later.slice(3, 13) > early.slice(3, 13)).toBe(true);
  });

  it('encodes the timestamp deterministically', () => {
    const bytes = new Uint8Array(10);
    expect(newUlid(0, bytes)).toBe('00000000000000000000000000');
    expect(newUlid(1, bytes).slice(0, 10)).toBe('0000000001');
  });
});

describe('gate decision input', () => {
  it('accepts approve | reject | request_changes with an actor', () => {
    for (const decision of ['approve', 'reject', 'request_changes'] as const) {
      expect(gateDecisionRequestSchema.parse({ decision, actor: 'ada' }).decision).toBe(decision);
    }
    expect(
      gateDecisionRequestSchema.parse({
        decision: 'request_changes',
        actor: 'ada',
        feedback: 'add a regression test',
      }).feedback,
    ).toBe('add a regression test');
  });

  it('rejects an unknown decision and a missing actor', () => {
    expect(() =>
      gateDecisionRequestSchema.parse({ decision: 'merge', actor: 'ada' }),
    ).toThrow();
    expect(() => gateDecisionRequestSchema.parse({ decision: 'approve' })).toThrow();
  });
});

describe('autonomy request', () => {
  it('requires an actor and a reason for the kill switch / enable path', () => {
    const parsed = autonomyRequestSchema.parse({
      factory: 'example',
      enabled: false,
      actor: 'ada',
      reason: 'incident 42',
    });
    expect(parsed.enabled).toBe(false);
    expect(() =>
      autonomyRequestSchema.parse({ factory: 'example', enabled: true, actor: 'ada' }),
    ).toThrow();
  });

  it('accepts an explicit override with actor and reason', () => {
    const parsed = autonomyRequestSchema.parse({
      factory: 'example-lights-off',
      enabled: true,
      actor: 'ada',
      reason: 'first lights-off trial',
      override: { actor: 'ada', reason: 'benchmarks not built yet, accepted risk' },
    });
    expect(parsed.override?.actor).toBe('ada');
  });
});
