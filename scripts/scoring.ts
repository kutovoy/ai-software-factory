#!/usr/bin/env bun
/**
 * Scoring CLI (Phase 4a).
 *
 *   bun scripts/scoring.ts schedule                 # create one Temporal Schedule per factory
 *   bun scripts/scoring.ts run --factory example   # score the last day of terminal runs
 *   bun scripts/scoring.ts run --factory example --run run_123 --force
 *
 * Needs Temporal + Postgres (compose). No model credentials with the stub judge.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeClient,
  ensureScoringSchedule,
  loadConfig,
  startScoringWorkflow,
} from '../packages/orchestration/src/index';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const command = process.argv[2];

  if (command === 'schedule') {
    const requested = process.argv.slice(3).filter((arg) => !arg.startsWith('--'));
    const factories =
      requested.length > 0
        ? requested
        : readdirSync(config.factoryRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();
    const result = await ensureScoringSchedule(config, factories);
    console.log(JSON.stringify({ cron: config.scoringCron, ...result }, null, 2));
    return;
  }

  if (command === 'run') {
    const factory = flag('factory');
    if (!factory) {
      console.error('--factory <name> is required');
      process.exit(1);
    }
    const runId = flag('run');
    const windowDays = flag('window') ? Number(flag('window')) : config.scoringWindowDays;
    const started = await startScoringWorkflow(
      {
        factory,
        factoryRoot: join(config.factoryRoot, factory),
        trigger: 'on_demand',
        ...(runId ? { runIds: [runId] } : {}),
        ...(runId ? { force: true } : {}),
        windowDays,
        judgeMode: config.scoringJudgeMode,
      },
      config,
    );
    console.log(JSON.stringify({ factory, runId: runId ?? null, ...started }, null, 2));
    return;
  }

  console.error('usage: bun scripts/scoring.ts schedule | run --factory <name> [--run <id>]');
  process.exit(1);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(() => closeClient());
