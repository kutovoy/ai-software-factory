import type { HarnessId, RunnerKindName } from './types';

/**
 * Runner selection for a stage run.
 *
 * Precedence:
 *  - the fake harness always uses the ephemeral fake runner;
 *  - an explicit work-item `runnerOverride` wins over the compiled stage node;
 *  - otherwise the stage agent's runner wins;
 *  - otherwise the factory/work-item default.
 *
 * Before this helper, `defaultRunner` was only a fallback, so a work-item `runner: remote`
 * request was silently ignored whenever the compiled stage node declared a runner (which
 * the factory `agentDefaults.runner` always does).
 */
export function selectStageRunner(input: {
  harness: HarnessId;
  runnerOverride?: RunnerKindName;
  nodeRunner?: string;
  defaultRunner: RunnerKindName;
}): RunnerKindName {
  if (input.harness === 'fake') return 'fake';
  if (input.runnerOverride !== undefined) return input.runnerOverride;
  return (input.nodeRunner as RunnerKindName | undefined) ?? input.defaultRunner;
}
