#!/usr/bin/env bun
/**
 * Reap orphaned runner containers.
 *
 *   bun scripts/reap-runners.ts            # dry run: show what would be removed
 *   bun scripts/reap-runners.ts --apply    # remove containers whose run is terminal/missing
 *
 * The reaper is DB- and Temporal-aware: it does not remove a container while its run is
 * live. Use this for local cleanup; the worker runs the same logic periodically as a
 * safety net.
 */
import { loadConfig, reapRunnerContainers } from '../packages/orchestration/src/index';

const apply = process.argv.includes('--apply');
const config = loadConfig();

const result = await reapRunnerContainers(config, { dryRun: !apply });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.errors.length > 0) process.exitCode = 1;
