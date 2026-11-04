import { describe, expect, test } from 'bun:test';
import type { OrchestrationConfig } from '../src/config';
import {
  reapRunnerContainers,
  type ManagedContainer,
  type RunnerReaperDeps,
} from '../src/runner-reaper';

const config = {
  runnerReaperDryRun: false,
  runnerReaperMaxAgeMs: 6 * 60 * 60 * 1000,
  runnerReaperGraceMs: 5 * 60 * 1000,
} as OrchestrationConfig;

function container(overrides: Partial<ManagedContainer> = {}): ManagedContainer {
  return {
    id: 'container-1',
    name: 'factory-runner-run-1',
    runId: 'run-1',
    workspace: '/tmp/factory-run-test',
    createdAt: '2026-11-01T00:00:00.000Z',
    ageMs: 10 * 60 * 1000,
    ...overrides,
  };
}

function deps(input: {
  containers: ManagedContainer[];
  statuses: Record<string, string | null>;
  workflows: Record<string, 'running' | 'closed' | 'missing' | 'unavailable'>;
}): RunnerReaperDeps & { removed: string[]; orphaned: string[] } {
  const removed: string[] = [];
  const orphaned: string[] = [];
  return {
    removed,
    orphaned,
    listContainers: async () => input.containers,
    runStatus: async (runId) => input.statuses[runId] ?? null,
    workflowStatus: async (runId) => input.workflows[runId] ?? 'running',
    removeContainer: async (id) => {
      removed.push(id);
    },
    removeWorkspace: async () => undefined,
    markRunOrphaned: async (runId) => {
      orphaned.push(runId);
    },
  };
}

describe('runner reaper', () => {
  test('removes a container whose run is terminal', async () => {
    const fake = deps({
      containers: [container()],
      statuses: { 'run-1': 'ok' },
      workflows: {},
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(1);
    expect(fake.removed).toEqual(['container-1']);
    expect(fake.orphaned).toEqual([]);
  });

  test('removes a container whose run row is missing', async () => {
    const fake = deps({
      containers: [container()],
      statuses: {},
      workflows: {},
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(1);
    expect(result.actions[0]?.reason).toBe('run_missing');
  });

  test('removes a running run whose workflow is closed', async () => {
    const fake = deps({
      containers: [container()],
      statuses: { 'run-1': 'running' },
      workflows: { 'run-1': 'closed' },
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(1);
    expect(fake.orphaned).toEqual(['run-1']);
  });

  test('does not remove a just-started run whose workflow is not visible yet', async () => {
    const fake = deps({
      containers: [container({ ageMs: 60_000 })],
      statuses: { 'run-1': 'running' },
      workflows: { 'run-1': 'missing' },
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('removes an old run whose workflow is missing', async () => {
    const fake = deps({
      containers: [container({ ageMs: 10 * 60 * 1000 })],
      statuses: { 'run-1': 'running' },
      workflows: { 'run-1': 'missing' },
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(1);
    expect(result.actions[0]?.reason).toBe('workflow_missing');
  });

  test('keeps a live run', async () => {
    const fake = deps({
      containers: [container({ ageMs: 60 * 60 * 1000 })],
      statuses: { 'run-1': 'running' },
      workflows: { 'run-1': 'running' },
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('skips running containers when Temporal is unavailable', async () => {
    const fake = deps({
      containers: [container({ ageMs: 10 * 60 * 60 * 1000 })],
      statuses: { 'run-1': 'running' },
      workflows: { 'run-1': 'unavailable' },
    });
    const result = await reapRunnerContainers(config, {}, fake);
    expect(result.removed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.actions[0]?.reason).toBe('temporal_unavailable');
  });

  test('dry run reports without removing', async () => {
    const fake = deps({
      containers: [container()],
      statuses: { 'run-1': 'cancelled' },
      workflows: {},
    });
    const result = await reapRunnerContainers(config, { dryRun: true }, fake);
    expect(result.wouldRemove).toBe(1);
    expect(result.removed).toBe(0);
    expect(fake.removed).toEqual([]);
  });
});
