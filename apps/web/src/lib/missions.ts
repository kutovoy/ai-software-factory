import type {
  MissionFeatureStatusWire,
  MissionMilestoneStatusWire,
  MissionStatusWire,
  MissionSummary,
  MissionValidationStatusWire,
} from './types';

/**
 * Read-only derivations for Mission Control (`web-console` spec: "Mission Control").
 *
 * The API projects mission rows and their children; the console only renders what is
 * recorded. Progress is computed from the counters the list projection returns, so a mission
 * with no features reports `0/0` instead of an invented percentage.
 */

export const MISSION_STATUSES: MissionStatusWire[] = [
  'planning',
  'awaiting_plan_approval',
  'running',
  'paused',
  'blocked',
  'done',
  'failed',
  'cancelled',
];

/** Terminal statuses never offer pause/resume/cancel/retry controls. */
export const TERMINAL_MISSION_STATUSES: MissionStatusWire[] = ['done', 'failed', 'cancelled'];

export type MissionTone = 'neutral' | 'success' | 'danger' | 'warning' | 'info';

export function missionStatusTone(status: string): MissionTone {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'paused':
      return 'warning';
    case 'running':
      return 'info';
    case 'awaiting_plan_approval':
    case 'planning':
      return 'info';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function milestoneStatusTone(status: MissionMilestoneStatusWire | string): MissionTone {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'blocked':
    case 'validating':
      return 'warning';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

export function featureStatusTone(status: MissionFeatureStatusWire | string): MissionTone {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
      return 'info';
    case 'ready':
      return 'warning';
    case 'skipped':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function validationStatusTone(status: MissionValidationStatusWire | string): MissionTone {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'error':
      return 'danger';
    case 'running':
      return 'info';
    default:
      return 'neutral';
  }
}

export interface MissionProgressView {
  /** 0–100; `0` when the plan declares no features (never a fake 100%). */
  percent: number;
  label: string;
  done: number;
  total: number;
  failed: number;
}

/** Feature progress from the list projection counters. */
export function missionProgress(
  summary: Pick<MissionSummary, 'featureDone' | 'featureTotal' | 'featureFailed'>,
): MissionProgressView {
  const total = summary.featureTotal ?? 0;
  const done = summary.featureDone ?? 0;
  const failed = summary.featureFailed ?? 0;
  return {
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    label: `${done}/${total}`,
    done,
    total,
    failed,
  };
}

/** Short display form of a mission child id (`mst_…` / `mft_…`): the ULID tail. */
export function shortMissionId(id: string | null | undefined): string {
  if (!id) return '—';
  const tail = id.split('_').pop() ?? id;
  return tail.slice(-8);
}

/** A one-line, human-readable summary of a mission event payload. */
export function eventSummary(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return '';
  for (const key of ['reason', 'summary', 'message', 'title', 'status', 'featureId', 'milestoneId']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const entries = Object.entries(payload).filter(
    ([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}

/** True while a plan gate is waiting for a human decision. */
export function awaitingPlanApproval(status: string): boolean {
  return status === 'awaiting_plan_approval';
}
