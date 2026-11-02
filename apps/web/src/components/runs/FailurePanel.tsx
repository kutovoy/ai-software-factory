import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { CopyButton } from '@/components/runs/CopyButton';
import { RetryRunButton } from '@/components/runs/RetryRunButton';
import {
  failureCode,
  failureMessage,
  remediationFor,
  temporalWorkflowUrl,
} from '@/lib/failure';
import type { RunRow, RunStep } from '@/lib/types';

/**
 * Failure panel (spec `run-lifecycle` › Failure panel).
 *
 * A failed run used to surface one sentence — the Temporal wrapper `Activity task failed` —
 * with no code, no failed step and no way into the workflow history. This panel answers the
 * operator's four questions in one place: what broke (message + code), which steps failed,
 * which workflow to inspect, and what to do about it. A cancelled run shows its reason and
 * the actor that requested it; a healthy run renders nothing at all.
 */
export function FailurePanel({
  factoryId,
  run,
  steps,
  summary,
}: {
  factoryId: string;
  run: RunRow;
  steps: RunStep[];
  summary: string | null;
}) {
  if (run.status !== 'error' && run.status !== 'cancelled') return null;

  const failed = steps.filter((step) => step.status === 'error');
  const temporalUrl = temporalWorkflowUrl(run.workflow_id);
  const cancelled = run.status === 'cancelled';

  if (cancelled) {
    // The read model records *when* a cancel was requested, not *who* asked: the console is
    // the only writer, so a request timestamp identifies the console as the actor.
    const requestedByConsole = Boolean(
      (run as RunRow & { cancel_requested_at?: string | null }).cancel_requested_at,
    );
    return (
      <Card testId="run-failure-panel" className="border-amber-200">
        <CardHeader
          title="Run cancelled"
          hint="Cancellation is cooperative: the harness was told to stop and the run ended cancelled."
          action={
            <Badge tone="warning" testId="run-failure-status">
              cancelled
            </Badge>
          }
        />
        <CardBody className="space-y-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-slate-400">Reason</p>
            <p data-testid="run-cancel-reason" className="break-words text-sm text-slate-800">
              {run.cancel_reason ?? summary ?? run.summary ?? 'cancelled'}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-slate-400">Actor</p>
            <p data-testid="run-cancel-actor" className="text-sm text-slate-800">
              {requestedByConsole ? 'console' : 'workflow'}
            </p>
          </div>
          {failed.length > 0 ? <FailedSteps steps={failed} /> : null}
          <WorkflowReference workflowId={run.workflow_id} url={temporalUrl} />
        </CardBody>
      </Card>
    );
  }

  const code = failureCode(run.error) ?? failureCode(summary);
  const message = failureMessage(run.error ?? summary);

  return (
    <Card testId="run-failure-panel" className="border-red-200">
      <CardHeader
        title="Run failed"
        hint="The cause below comes from the failing activity, not from Temporal’s wrapper message."
        action={
          <Badge tone="danger" testId="run-failure-status">
            error
          </Badge>
        }
      />
      <CardBody className="space-y-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Error</p>
          <p
            data-testid="run-failure-message"
            className="break-words font-mono text-sm text-red-700"
          >
            {message}
          </p>
        </div>

        {code ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs uppercase tracking-wide text-slate-400">Code</p>
            <Badge tone="danger" mono testId="run-failure-code">
              {code}
            </Badge>
          </div>
        ) : null}

        <FailedSteps steps={failed} />

        <WorkflowReference workflowId={run.workflow_id} url={temporalUrl} />

        <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-xs uppercase tracking-wide text-slate-400">What to do</p>
          <p data-testid="run-failure-hint" className="mt-1 text-sm text-slate-700">
            {remediationFor(code)}
          </p>
        </div>

        {run.kind === 'chat' ? <RetryRunButton factoryId={factoryId} runId={run.id} /> : null}
      </CardBody>
    </Card>
  );
}

function FailedSteps({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-slate-400">Failed steps</p>
        <p data-testid="run-failure-steps-empty" className="text-sm text-slate-600">
          No step recorded an error.
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-slate-400">Failed steps</p>
      <ul data-testid="run-failure-steps" className="mt-1 space-y-1">
        {steps.map((step) => (
          <li
            key={step.step_id}
            data-testid="run-failure-step"
            data-step-id={step.step_id}
            className="flex flex-wrap items-baseline gap-2 text-sm"
          >
            <span className="font-mono text-xs text-slate-800">{step.step_id}</span>
            <span className="text-xs text-slate-500">{step.kind}</span>
            <Badge tone="danger">{step.status}</Badge>
            {step.error ? (
              <span className="min-w-0 break-words font-mono text-xs text-red-700">
                {step.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowReference({ workflowId, url }: { workflowId: string; url: string | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-slate-400">Workflow</p>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="run-failure-workflow-id"
          title={workflowId}
          className="min-w-0 break-all font-mono text-xs text-slate-800"
        >
          {workflowId}
        </span>
        <CopyButton value={workflowId} testId="run-failure-workflow-copy" />
        {url ? (
          <Link
            data-testid="run-failure-temporal-link"
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-sky-700 underline decoration-sky-300 underline-offset-2"
          >
            Open in Temporal ↗
          </Link>
        ) : null}
      </div>
    </div>
  );
}
