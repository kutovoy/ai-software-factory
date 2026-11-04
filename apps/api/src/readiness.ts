import { loadDefinition, scanReadiness, type ReadinessReport } from '@factory/core';
import type { ApiConfig } from './config';
import { definitionInvalid } from './errors';
import { resolveFactoryDir } from './factories';

/**
 * `GET /factories/:factoryId/readiness` (spec `agent-readiness`, roadmap item 2).
 *
 * Deterministic: it reads the local checkout (`REPO_ROOT`) and the loaded definition. No
 * model call, no shell — the same input always yields the same score.
 */
export async function getReadinessForApi(
  config: ApiConfig,
  factory: string,
): Promise<ReadinessReport> {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);

  return scanReadiness({
    repoRoot: config.repoRoot,
    definition,
    ...(definition.manifest.readiness?.thresholds
      ? { thresholds: definition.manifest.readiness.thresholds }
      : {}),
  });
}
