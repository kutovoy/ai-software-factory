import { loadDefinition, getAutonomyState } from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { definitionInvalid } from './errors';
import { resolveFactoryDir } from './factories';

/**
 * Governance projection (roadmap item 10).
 *
 * The definition is authoritative for autonomy level, model allowlist and action policy.
 * The live autonomy kill switch comes from `autonomy_state`; recent policy decisions come
 * from `run_steps` (kind `policy`). No new table.
 */

export interface GovernanceView {
  factory: string;
  governance: {
    autonomyLevel: 'observe' | 'assist' | 'auto' | 'full';
    allowedModels: string[];
    denyActions: string[];
    requireHumanActions: string[];
    audit: { export: 'jsonl' | 'otel'; otlpEndpoint: string | null };
  } | null;
  autonomy: {
    enabled: boolean;
    paused: boolean;
    actor: string | null;
    reason: string | null;
  };
  recentDecisions: Array<{
    runId: string;
    stepId: string;
    action: string;
    decision: string;
    reason: string;
    at: string | null;
  }>;
}

export async function getGovernanceForApi(
  config: ApiConfig,
  factory: string,
): Promise<GovernanceView> {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);
  const sql = getSql();
  const state = await getAutonomyState(sql, factory);
  const rows = (await sql`
    select s.run_id, s.step_id, s.detail, s.started_at
    from run_steps s
    join runs r on r.id = s.run_id
    where r.factory = ${factory} and s.kind = 'policy'
    order by s.started_at desc
    limit 20
  `) as Array<{
    run_id: string;
    step_id: string;
    detail: unknown;
    started_at: string | null;
  }>;

  const governance = definition.manifest.governance;
  return {
    factory,
    governance: governance
      ? {
          autonomyLevel: governance.autonomyLevel,
          allowedModels: [...(governance.allowedModels ?? [])],
          denyActions: [...(governance.denyActions ?? [])],
          requireHumanActions: [...(governance.requireHumanActions ?? [])],
          audit: {
            export: governance.audit?.export ?? 'jsonl',
            otlpEndpoint: governance.audit?.otlpEndpoint ?? null,
          },
        }
      : null,
    autonomy: {
      enabled: state?.enabled ?? false,
      paused: state?.paused ?? false,
      actor: state?.actor ?? null,
      reason: state?.reason ?? null,
    },
    recentDecisions: rows.map((row) => {
      const detail = (row.detail ?? {}) as {
        action?: string;
        decision?: string;
        reason?: string;
      };
      return {
        runId: row.run_id,
        stepId: row.step_id,
        action: detail.action ?? '',
        decision: detail.decision ?? '',
        reason: detail.reason ?? '',
        at: row.started_at,
      };
    }),
  };
}
