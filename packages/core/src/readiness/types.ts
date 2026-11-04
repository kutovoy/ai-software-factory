/**
 * Agent-readiness types (roadmap item 2). The scan is deterministic: it reads the local
 * checkout and the loaded factory definition, never a model. Every check carries concrete
 * evidence (or an explicit "not found") and a remediation hint.
 */

export type ReadinessStatus = 'ready' | 'warn' | 'not_ready';

export type ReadinessSectionId = 'repository' | 'factory';

export interface ReadinessCheck {
  id: string;
  label: string;
  section: ReadinessSectionId;
  passed: boolean;
  weight: number;
  evidence: string;
  remediation: string;
}

export interface ReadinessSection {
  id: ReadinessSectionId;
  label: string;
  score: number;
  checks: ReadinessCheck[];
}

export interface ReadinessThresholds {
  ready: number;
  warn: number;
}

export interface ReadinessReport {
  root: string;
  generatedAt: string;
  score: number;
  status: ReadinessStatus;
  thresholds: ReadinessThresholds;
  sections: ReadinessSection[];
  checks: ReadinessCheck[];
  summary: string;
}
