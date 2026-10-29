import type { Tone } from '@/components/ui/Badge';
import type {
  CanaryStatusWire,
  ImprovementAuthorityWire,
  ProposalStatusWire,
  ProposalWire,
} from './types';

export const AUTHORITY_OPTIONS: {
  value: ImprovementAuthorityWire;
  label: string;
  description: string;
}[] = [
  {
    value: 'propose_only',
    label: 'Propose only',
    description: 'Open a pull request; a human merges it. Never merges automatically.',
  },
  {
    value: 'auto_merge_on_benchmark',
    label: 'Auto-merge on benchmark',
    description:
      'Merge only with a passing, calibrated benchmark attestation for this commit + config hash; otherwise open a PR.',
  },
  {
    value: 'canary',
    label: 'Canary',
    description:
      'Publish a candidate version and route a configured percentage of new work to it by deterministic hash; promote or roll back after the observation window.',
  },
];

export function authorityTone(authority: string): Tone {
  if (authority === 'auto_merge_on_benchmark') return 'warning';
  if (authority === 'canary') return 'info';
  return 'neutral';
}

export function proposalStatusTone(status: ProposalStatusWire): Tone {
  switch (status) {
    case 'merged':
      return 'success';
    case 'pr_open':
    case 'accepted':
    case 'canary':
      return 'info';
    case 'rejected':
    case 'no_improvement':
    case 'rolled_back':
      return 'neutral';
    case 'failed':
      return 'danger';
    case 'canary_not_available':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function proposalStatusLabel(status: ProposalStatusWire): string {
  switch (status) {
    case 'pr_open':
      return 'PR open';
    case 'canary':
      return 'canary rollout';
    case 'rolled_back':
      return 'rolled back';
    case 'canary_not_available':
      return 'canary (legacy)';
    case 'no_improvement':
      return 'no improvement';
    default:
      return status.replace(/_/g, ' ');
  }
}

/* ------------------------------------------------------------ canary */

export function canaryStatusTone(status: CanaryStatusWire): Tone {
  switch (status) {
    case 'active':
      return 'info';
    case 'promoted':
      return 'success';
    case 'rolled_back':
      return 'warning';
    case 'unavailable':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function canaryStatusLabel(status: CanaryStatusWire): string {
  switch (status) {
    case 'pending':
      return 'publishing';
    case 'active':
      return 'active';
    case 'promoted':
      return 'promoted';
    case 'rolled_back':
      return 'rolled back';
    case 'unavailable':
      return 'unavailable';
  }
}

/** `1h 20m`, `12m 04s`, `45s` — a stable countdown label for the observation window. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${(delta * 100).toFixed(1)}pp`;
}

/** A compact textual diff for the viewer: one line per changed field/file. */
export function diffText(diff: ProposalWire['diff']): string {
  return diff
    .map((entry) => {
      const before = entry.before.split('\n').length;
      const after = entry.after.split('\n').length;
      return `${entry.path} (${before} → ${after} lines)`;
    })
    .join('\n');
}

export function formatImpact(impact: number): string {
  return impact.toFixed(2);
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Evidence fields are stored as JSON; render only what exists. */
export function evidenceLines(evidence: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const runIds = evidence.runIds;
  if (Array.isArray(runIds) && runIds.length > 0) {
    lines.push(`Runs: ${runIds.join(', ')}`);
  }
  if (typeof evidence.failedRuns === 'number') {
    lines.push(
      `Failed: ${evidence.failedRuns} of ${typeof evidence.totalRuns === 'number' ? evidence.totalRuns : '?'}`,
    );
  }
  if (typeof evidence.costUsd === 'number') lines.push(`Cost: $${evidence.costUsd.toFixed(4)}`);
  const rationales = evidence.scorerRationales;
  if (Array.isArray(rationales)) {
    for (const entry of rationales as { scorer?: string; rationale?: string }[]) {
      if (entry.rationale) lines.push(`${entry.scorer ?? 'scorer'}: ${entry.rationale}`);
    }
  }
  if (typeof evidence.actor === 'string') lines.push(`Actor: ${evidence.actor}`);
  if (typeof evidence.reason === 'string') lines.push(`Reason: ${evidence.reason}`);
  return lines;
}

/** Reasons are stable codes; give them a human sentence without hiding the code. */
export const ELIGIBILITY_REASONS: Record<string, string> = {
  insufficient_scored_runs: 'not enough scored runs in the window',
  no_calibrated_judges: 'no judge has a passing calibration for its current rubric',
  uncalibrated_judges: 'a judge score is uncalibrated, so proposals built on it are refused',
};
