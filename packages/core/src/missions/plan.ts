import type {
  MissionBudget,
  MissionFeaturePlan,
  MissionFeatureStatus,
  MissionMilestonePlan,
  MissionPlan,
  MissionProgress,
} from './types';
import { missionPlanSchema } from './schema';

/**
 * Pure mission-plan helpers. The planner and the workflow share these; keeping them free
 * of Node APIs makes them safe for Temporal's deterministic sandbox and easy to test.
 */

export interface MissionPlanValidation {
  errors: string[];
  plan: MissionPlan | null;
}

/** Validates the shape plus referential integrity: ids, dependencies, assertions, cycles. */
export function validateMissionPlan(value: unknown): MissionPlanValidation {
  const parsed = missionPlanSchema.safeParse(value);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      ),
      plan: null,
    };
  }

  const plan = parsed.data;
  const errors: string[] = [];
  const milestoneIds = new Set<string>();
  const featureIds = new Set<string>();
  const assertionIds = new Set(plan.validationContract.assertions.map((item) => item.id));

  if (assertionIds.size !== plan.validationContract.assertions.length) {
    errors.push('validation contract contains duplicate assertion ids');
  }

  for (const milestone of plan.milestones) {
    if (milestoneIds.has(milestone.id)) {
      errors.push(`duplicate milestone id "${milestone.id}"`);
    }
    milestoneIds.add(milestone.id);
    if (milestone.features.length === 0) {
      errors.push(`milestone "${milestone.id}" has no features`);
    }
    for (const feature of milestone.features) {
      if (featureIds.has(feature.id)) {
        errors.push(`duplicate feature id "${feature.id}"`);
      }
      featureIds.add(feature.id);
      if (feature.dependsOn.includes(feature.id)) {
        errors.push(`feature "${feature.id}" depends on itself`);
      }
      for (const dependency of feature.dependsOn) {
        if (!featureIds.has(dependency) && !allFeatureIds(plan).has(dependency)) {
          errors.push(`feature "${feature.id}" depends on unknown feature "${dependency}"`);
        }
      }
      if (feature.acceptanceCheckIds.length === 0) {
        errors.push(`feature "${feature.id}" claims no validation assertions`);
      }
      for (const assertionId of feature.acceptanceCheckIds) {
        if (!assertionIds.has(assertionId)) {
          errors.push(
            `feature "${feature.id}" claims unknown assertion "${assertionId}"`,
          );
        }
      }
    }
  }

  if (errors.length === 0) {
    try {
      featureDependencyOrder(plan);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { errors, plan: errors.length === 0 ? plan : null };
}

function allFeatureIds(plan: MissionPlan): Set<string> {
  const ids = new Set<string>();
  for (const milestone of plan.milestones) {
    for (const feature of milestone.features) ids.add(feature.id);
  }
  return ids;
}

/**
 * Topological order across all features, stable by milestone order then feature order.
 * Throws on a dependency cycle or an unknown dependency.
 */
export function featureDependencyOrder(plan: MissionPlan): MissionFeaturePlan[] {
  const features: MissionFeaturePlan[] = [];
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

  const orderIndex = new Map(features.map((feature, index) => [feature.id, index]));
  const ready = features
    .filter((feature) => (indegree.get(feature.id) ?? 0) === 0)
    .map((feature) => feature.id)
    .sort((left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0));

  const ordered: MissionFeaturePlan[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const feature = byId.get(id);
    if (feature) ordered.push(feature);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort((left, right) => (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0));
      }
    }
  }

  if (ordered.length !== features.length) {
    throw new Error('mission feature dependency graph contains a cycle');
  }
  return ordered;
}

export interface RunnableMissionFeature {
  milestone: MissionMilestonePlan;
  feature: MissionFeaturePlan;
}

/**
 * The first feature that may run: pending/ready, all dependencies done, and its milestone
 * is not already done. Returns null when nothing is runnable (all done, blocked or waiting
 * on a failed dependency).
 */
export function nextRunnableFeature(
  plan: MissionPlan,
  statuses: Record<string, MissionFeatureStatus>,
): RunnableMissionFeature | null {
  for (const milestone of [...plan.milestones].sort((a, b) => a.order - b.order)) {
    for (const feature of [...milestone.features].sort((a, b) => a.order - b.order)) {
      const status = statuses[feature.id] ?? 'pending';
      if (status !== 'pending' && status !== 'ready') continue;
      const dependenciesDone = feature.dependsOn.every(
        (dependency) => (statuses[dependency] ?? 'pending') === 'done',
      );
      if (!dependenciesDone) continue;
      return { milestone, feature };
    }
  }
  return null;
}

export function milestoneProgress(
  milestone: MissionMilestonePlan,
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

export function missionProgress(
  plan: MissionPlan,
  featureStatuses: Record<string, MissionFeatureStatus>,
): MissionProgress {
  const features = { total: 0, done: 0, failed: 0, running: 0 };
  const milestones = { total: plan.milestones.length, done: 0, running: 0 };
  for (const milestone of plan.milestones) {
    const progress = milestoneProgress(milestone, featureStatuses);
    features.total += progress.total;
    features.done += progress.done;
    features.failed += progress.failed;
    features.running += progress.running;
    if (progress.total > 0 && progress.done === progress.total) milestones.done += 1;
    else if (progress.running > 0) milestones.running += 1;
  }
  return {
    features,
    milestones,
    currentMilestoneId: null,
    currentFeatureId: null,
  };
}

export function assertionsForMilestone(plan: MissionPlan, milestoneId: string): Set<string> {
  const milestone = plan.milestones.find((entry) => entry.id === milestoneId);
  const ids = new Set<string>();
  for (const feature of milestone?.features ?? []) {
    for (const assertion of feature.acceptanceCheckIds) ids.add(assertion);
  }
  return ids;
}

export function featureById(plan: MissionPlan, featureId: string): MissionFeaturePlan | null {
  for (const milestone of plan.milestones) {
    const feature = milestone.features.find((entry) => entry.id === featureId);
    if (feature) return feature;
  }
  return null;
}

export function milestoneForFeature(
  plan: MissionPlan,
  featureId: string,
): MissionMilestonePlan | null {
  for (const milestone of plan.milestones) {
    if (milestone.features.some((feature) => feature.id === featureId)) return milestone;
  }
  return null;
}

export interface MissionBudgetUsage {
  costUsd: number;
  runs: number;
  startedAt: string | null;
  now?: Date;
}

/** Returns a stable reason when a mission cap would be exceeded, else null. */
export function missionBudgetExceeded(
  budget: MissionBudget | null | undefined,
  usage: MissionBudgetUsage,
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
