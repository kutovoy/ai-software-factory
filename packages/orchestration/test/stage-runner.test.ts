import { describe, expect, test } from 'bun:test';
import { selectStageRunner } from '../src/stage-runner';

describe('stage runner selection', () => {
  test('the fake harness always uses the fake runner', () => {
    expect(
      selectStageRunner({
        harness: 'fake',
        runnerOverride: 'remote',
        nodeRunner: 'local-docker',
        defaultRunner: 'local-docker',
      }),
    ).toBe('fake');
  });

  test('an explicit work-item runner override wins over the stage node', () => {
    expect(
      selectStageRunner({
        harness: 'opencode',
        runnerOverride: 'remote',
        nodeRunner: 'local-docker',
        defaultRunner: 'local-docker',
      }),
    ).toBe('remote');
  });

  test('the stage node runner wins when there is no override', () => {
    expect(
      selectStageRunner({
        harness: 'opencode',
        nodeRunner: 'local-process',
        defaultRunner: 'local-docker',
      }),
    ).toBe('local-process');
  });

  test('the default runner is the final fallback', () => {
    expect(
      selectStageRunner({
        harness: 'opencode',
        defaultRunner: 'local-docker',
      }),
    ).toBe('local-docker');
  });
});
