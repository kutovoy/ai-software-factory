import type {
  MissionBudgetData,
  MissionFeaturePlanData,
  MissionFeatureStatus,
  MissionMilestonePlanData,
  MissionPlanData,
} from './types';

/**
 * Workflow-safe mission-plan helpers. The core module has the Zod/schema version; this
 * file intentionally imports only types so it can run inside Temporal's sandbox.
 */

export interface RunnableMissionFeature {
  milestone: MissionMilestonePlanData;
  feature: MissionFeaturePlanData;
}

export function missionFeatureOrder(plan: MissionPlanData): MissionFeaturePlanData[] {
  const features: MissionFeaturePlanData[] = [];
  for (const milestone of [...plan.milestones].sort((a, b) => a.order - b.order)) {
    features.push(...[...milestone.features].sort((a, b) => a.order - b.order));
  }

  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const feature of features) {
    indegree.set(feature.id, feature.dependsOn.length);
    for (const dependency of feature.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`feature "${feature.id}" depends on unknown feature "${dependency}"`);
      }
      const list = dependents.get(dependency) ?? [];
      list.push(feature.id);
      dependents.set(dependency, list);
    }
  }

  const index = new Map(features.map((feature, position) => [feature.id, position]));
  const ready = features
    .filter((feature) => (indegree.get(feature.id) ?? 0) === 0)
    .map((feature) => feature.id)
    .sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));

  const ordered: MissionFeaturePlanData[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const feature = byId.get(id);
    if (feature) ordered.push(feature);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((left, right) => (index.get(left) ?? 0) - (index.get(right) ?? 0));
      }
    }
  }

  if (ordered.length !== features.length) {
    throw new Error('mission feature dependency graph contains a cycle');
  }
  return ordered;
}

export function nextRunnableMissionFeature(
  plan: MissionPlanData,
  statuses: Record<string, MissionFeatureStatus>,
): RunnableMissionFeature | null {
  for (const milestone of [...plan.milestones].sort((a, b) => a.order - b.order)) {
    for (const feature of [...milestone.features].sort((a, b) => a.order - b.order)) {
      const status = statuses[feature.id] ?? 'pending';
      if (status !== 'pending' && status !== 'ready') continue;
      if (!feature.dependsOn.every((dependency) => (statuses[dependency] ?? 'pending') === 'done')) {
        continue;
      }
      return { milestone, feature };
    }
  }
  return null;
}

export function missionMilestoneProgress(
  milestone: MissionMilestonePlanData,
  statuses: Record<string, MissionFeatureStatus>,
): { total: number; done: number; failed: number; running: number } {
  const counts = { total: milestone.features.length, done: 0, failed: 0, running: 0 };
  for (const feature of milestone.features) {
    const status = statuses[feature.id] ?? 'pending';
    if (status === 'done') counts.done += 1;
    else if (status === 'failed') counts.failed += 1;
    else if (status === 'running') counts.running += 1;
  }
  return counts;
}

export function missionAssertionsForMilestone(plan: MissionPlanData, milestoneId: string): string[] {
  const milestone = plan.milestones.find((entry) => entry.id === milestoneId);
  const ids = new Set<string>();
  for (const feature of milestone?.features ?? []) {
    for (const assertion of feature.acceptanceCheckIds) ids.add(assertion);
  }
  return [...ids];
}

export function missionFeatureById(
  plan: MissionPlanData,
  featureId: string,
): MissionFeaturePlanData | null {
  for (const milestone of plan.milestones) {
    const feature = milestone.features.find((entry) => entry.id === featureId);
    if (feature) return feature;
  }
  return null;
}

export function missionMilestoneForFeature(
  plan: MissionPlanData,
  featureId: string,
): MissionMilestonePlanData | null {
  for (const milestone of plan.milestones) {
    if (milestone.features.some((feature) => feature.id === featureId)) return milestone;
  }
  return null;
}

export interface MissionBudgetUsageData {
  costUsd: number;
  runs: number;
  startedAt: string | null;
  now?: Date;
}

export function missionBudgetExceededData(
  budget: MissionBudgetData | null | undefined,
  usage: MissionBudgetUsageData,
): string | null {
  if (!budget) return null;
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) {
    return `mission spend ${usage.costUsd.toFixed(2)} reached maxCostUsd ${budget.maxCostUsd}`;
  }
  if (budget.maxRuns !== undefined && usage.runs >= budget.maxRuns) {
    return `mission started ${usage.runs} runs, reaching maxRuns ${budget.maxRuns}`;
  }
  if (budget.maxWallClockHours !== undefined && usage.startedAt) {
    const started = Date.parse(usage.startedAt);
    if (Number.isFinite(started)) {
      const now = usage.now?.getTime() ?? Date.now();
      const hours = (now - started) / (60 * 60 * 1000);
      if (hours >= budget.maxWallClockHours) {
        return `mission ran ${hours.toFixed(1)}h, reaching maxWallClockHours ${budget.maxWallClockHours}`;
      }
    }
  }
  return null;
}
