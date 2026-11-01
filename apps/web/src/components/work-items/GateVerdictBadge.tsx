import { Badge, type Tone } from '@/components/ui/Badge';
import type { GateDecisionVerdictWire } from '@/lib/types';

const LABELS: Record<GateDecisionVerdictWire['decision'], string> = {
  approve: 'approve',
  request_changes: 'request changes',
  reject: 'reject',
  unknown: 'no verdict',
};

const TONES: Record<GateDecisionVerdictWire['decision'], Tone> = {
  approve: 'success',
  request_changes: 'warning',
  reject: 'danger',
  unknown: 'neutral',
};

/**
 * Agent gate verdict (change `add-agent-verdicts`).
 *
 * Shows the decision an automatic agent gate took and where it came from — structured JSON,
 * the textual fallback, or no verdict at all. Renders nothing for human gates and older rows
 * that predate migration 015.
 */
export function GateVerdictBadge({
  verdict,
  testId = 'gate-verdict',
}: {
  verdict: GateDecisionVerdictWire | null | undefined;
  testId?: string;
}) {
  if (!verdict) return null;
  return (
    <span
      data-testid={testId}
      data-decision={verdict.decision}
      data-source={verdict.source}
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <Badge tone={TONES[verdict.decision]}>{LABELS[verdict.decision]}</Badge>
      <span className="font-mono text-[10px] text-slate-400">{verdict.source}</span>
      {verdict.summary ? (
        <span data-testid={`${testId}-summary`} className="text-xs text-slate-600">
          {verdict.summary}
        </span>
      ) : null}
    </span>
  );
}
