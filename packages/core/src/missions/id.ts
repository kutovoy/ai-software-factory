import { newUlid } from '../work-items/id';

export function newMissionId(nowMs: number = Date.now()): string {
  return `mis_${newUlid(nowMs)}`;
}

export function newMissionMilestoneId(nowMs: number = Date.now()): string {
  return `mst_${newUlid(nowMs)}`;
}

export function newMissionFeatureId(nowMs: number = Date.now()): string {
  return `mft_${newUlid(nowMs)}`;
}

export function newMissionValidationId(nowMs: number = Date.now()): string {
  return `mval_${newUlid(nowMs)}`;
}
