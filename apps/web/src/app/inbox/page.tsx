import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { GateDecisionActions } from '@/components/work-items/GateDecisionActions';
import { GateVerdictBadge } from '@/components/work-items/GateVerdictBadge';
import { SlaCountdown } from '@/components/work-items/SlaCountdown';
import { safeGet } from '@/lib/api';
import { shortCommit } from '@/lib/format';
import { TimeAgo } from '@/components/ui/TimeAgo';
import type { InboxProjectionWire } from '@/lib/types';
import { slaState } from '@/lib/work-items';

export const dynamic = 'force-dynamic';

const EMPTY_INBOX: InboxProjectionWire = {
  gates: [],
  permissions: [],
  failures: [],
  counts: { gates: 0, permissions: 0, failures: 0 },
};

/**
 * Inbox = only what needs *this* user right now. It is one batch projection
 * (`GET /api/v1/inbox`): pending gates, pending permissions and failed runs, owner-scoped
 * in SQL. The old page made one list call per factory plus a detail call per item (~112
 * API calls); this one makes one call.
 */
export default async function InboxPage() {
  const inbox = await safeGet<InboxProjectionWire>('/inbox', EMPTY_INBOX);
  const { gates, permissions: pendingPermissions, failures } = inbox;

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Inbox</h1>
        <p className="text-sm text-slate-500">
          Items that need you: stage gate approvals, unanswered permission requests and failed runs.
          Everything else is visible under Runs and the work-items board.
        </p>
      </header>

      {gates.length === 0 && pendingPermissions.length === 0 && failures.length === 0 ? (
        <EmptyState
          testId="inbox-empty"
          title="Nothing needs your attention"
          description="No pending gates, no pending permissions and no failed runs. New items appear here as soon as an agent asks for a decision."
        />
      ) : (
        <>
          <Card testId="inbox-gates">
            <CardHeader
              title={`Gate approvals (${gates.length})`}
              hint="A stage is parked on a durable wait until you decide. Requesting changes needs feedback."
            />
            {gates.length === 0 ? (
              <p data-testid="inbox-gates-empty" className="px-5 py-4 text-sm text-slate-500">
                No pending stage gates.
              </p>
            ) : (
              <ul data-testid="inbox-gates-list" className="divide-y divide-slate-100">
                {gates.map(({ workItem, factoryId, factoryName, gate }) => {
                  const sla = slaState(gate.slaAt);
                  const encoded = encodeURIComponent(factoryId);
                  return (
                    <li
                      key={`${workItem.id}:${gate.stage}:${gate.attempt}`}
                      data-testid="inbox-item"
                      data-kind="gate"
                      data-work-item-id={workItem.id}
                      data-stage={gate.stage}
                      data-gate={gate.gate}
                      data-attempt={gate.attempt}
                      className="space-y-2 px-5 py-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="warning" testId="inbox-gate-stage">
                          {gate.stage}
                        </Badge>
                        <Badge tone="neutral" mono>
                          {gate.gate}
                        </Badge>
                        <Link
                          href={`/factories/${encoded}/work-items/${encodeURIComponent(workItem.id)}`}
                          data-testid="inbox-gate-link"
                          className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                        >
                          {workItem.title}
                        </Link>
                        <span className="font-mono text-[11px] text-slate-400">{workItem.id}</span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {factoryName}@{shortCommit(workItem.definitionCommit)}
                        </span>
                        <span
                          className="ml-auto text-xs text-slate-500"
                          data-testid="inbox-gate-age"
                          data-requested-at={gate.requestedAt ?? ''}
                        >
                          waiting <TimeAgo value={gate.requestedAt} />
                        </span>
                        <SlaCountdown slaAt={gate.slaAt} testId="inbox-gate-sla" />
                      </div>
                      {gate.verdict ? (
                        <GateVerdictBadge verdict={gate.verdict} testId="inbox-gate-verdict" />
                      ) : null}
                      <GateDecisionActions
                        factoryId={factoryId}
                        workItemId={workItem.id}
                        stage={gate.stage}
                        slaLabel={sla.label}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {pendingPermissions.length > 0 || failures.length > 0 ? (
            <>
              <Card testId="inbox-permissions">
                <CardHeader
                  title={`Pending permissions (${pendingPermissions.length})`}
                  hint="An agent is blocked until you decide."
                />
                {pendingPermissions.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-slate-500">No pending permissions.</p>
                ) : (
                  <ul data-testid="inbox-list" className="divide-y divide-slate-100">
                    {pendingPermissions.map((item) => (
                      <li
                        key={`${item.runId}:${item.requestId}`}
                        data-testid="inbox-item"
                        data-kind="permission"
                        data-run-id={item.runId}
                        data-request-id={item.requestId}
                        className="flex flex-wrap items-center gap-3 px-5 py-3"
                      >
                        <Badge tone="warning" testId="inbox-item-kind">
                          permission
                        </Badge>
                        <Link
                          href={`/factories/${encodeURIComponent(item.factoryId)}/runs/${encodeURIComponent(item.runId)}?focus=permission:${encodeURIComponent(item.requestId)}`}
                          data-testid="inbox-item-link"
                          className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                        >
                          {item.title}
                        </Link>
                        <span className="font-mono text-xs text-slate-500">{item.action}</span>
                        <span className="font-mono text-[11px] text-slate-400">
                          {item.factoryName}@{shortCommit(item.commit)}
                        </span>
                        <span className="ml-auto text-xs text-slate-500" data-testid="inbox-item-age">
                          <TimeAgo value={item.requestedAt} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card testId="inbox-failures">
                <CardHeader
                  title={`Failed runs (${failures.length})`}
                  hint="Resolves automatically when a retry succeeds."
                />
                {failures.length === 0 ? (
                  <p className="px-5 py-4 text-sm text-slate-500">No failed runs.</p>
                ) : (
                  <ul data-testid="inbox-failures-list" className="divide-y divide-slate-100">
                    {failures.map((item) => (
                      <li
                        key={item.runId}
                        data-testid="inbox-item"
                        data-kind="failure"
                        data-run-id={item.runId}
                        data-error-code={item.errorCode}
                        className="flex flex-wrap items-center gap-3 px-5 py-3"
                      >
                        <Badge tone="danger" testId="inbox-item-kind">
                          failure
                        </Badge>
                        <Link
                          href={`/factories/${encodeURIComponent(item.factoryId)}/runs/${encodeURIComponent(item.runId)}`}
                          data-testid="inbox-item-link"
                          className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                        >
                          {item.title}
                        </Link>
                        <span className="font-mono text-xs text-red-700" data-testid="inbox-error-code">
                          {item.errorCode}
                        </span>
                        <span className="ml-auto text-xs text-slate-500" data-testid="inbox-item-age">
                          <TimeAgo value={item.at} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
