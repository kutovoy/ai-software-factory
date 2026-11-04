import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { getOrError } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { factoryHeading } from '@/lib/factory';
import { formatDateTime } from '@/lib/format';
import type {
  GuardHookEventWire,
  GuardHooksWire,
  ReadinessCheckWire,
  ReadinessReportWire,
  ReadinessSectionWire,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

function readinessTone(status: ReadinessReportWire['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'warn') return 'warning';
  return 'danger';
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ConfigTable({ hooks }: { hooks: GuardHooksWire }) {
  const keys = Array.from(
    new Set([...Object.keys(hooks.defaults ?? {}), ...Object.keys(hooks.config ?? {})]),
  ).sort();
  if (keys.length === 0) {
    return <p className="text-xs text-slate-500">No guard configuration is declared.</p>;
  }
  return (
    <table data-testid="guard-hooks-config" className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50">
        <tr>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Setting</th>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Declared</th>
          <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">Default</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {keys.map((key) => {
          const declared = (hooks.config ?? {})[key];
          const fallback = (hooks.defaults ?? {})[key];
          return (
            <tr key={key} data-testid="guard-hooks-config-row" data-key={key}>
              <td className="px-4 py-2 font-mono text-xs text-slate-800">{key}</td>
              <td className="px-4 py-2 font-mono text-xs text-slate-800">
                {declared === undefined ? '—' : formatConfigValue(declared)}
              </td>
              <td className="px-4 py-2 font-mono text-xs text-slate-600">{formatConfigValue(fallback)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GuardEventRow({ event, encoded }: { event: GuardHookEventWire; encoded: string }) {
  const passed = event.type !== 'guard.failed';
  const detail =
    typeof event.payload?.detail === 'string'
      ? event.payload.detail
      : typeof event.payload?.reason === 'string'
        ? event.payload.reason
        : null;
  return (
    <li
      data-testid="guard-event"
      data-type={event.type}
      data-work-item-id={event.workItemId}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
    >
      <Badge tone={passed ? 'success' : 'danger'}>{event.type.replace('guard.', '')}</Badge>
      {event.stage ? <span className="font-mono text-[11px] text-slate-500">{event.stage}</span> : null}
      <Link
        href={`/factories/${encoded}/work-items/${encodeURIComponent(event.workItemId)}`}
        data-testid="guard-event-work-item"
        className="font-mono text-[11px] text-sky-700 underline decoration-sky-200 underline-offset-2"
      >
        {event.workItemId}
      </Link>
      {event.actor ? <span className="text-[11px] text-slate-500">{event.actor}</span> : null}
      {detail ? <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">{detail}</span> : null}
      <TimeAgo className="ml-auto text-[11px] text-slate-400" value={event.createdAt} />
    </li>
  );
}

function SectionCard({ section }: { section: ReadinessSectionWire }) {
  return (
    <Card testId="readiness-section">
      <CardHeader
        title={section.label}
        hint={`${section.checks.filter((check) => check.passed).length} of ${section.checks.length} checks pass.`}
        action={
          <Badge tone={section.score >= 80 ? 'success' : section.score >= 60 ? 'warning' : 'danger'}>
            {section.score}/100
          </Badge>
        }
      />
      {section.checks.length === 0 ? (
        <CardBody>
          <EmptyState
            testId="readiness-section-empty"
            title="No checks in this section"
            description="The scanner returned no checks for this section."
          />
        </CardBody>
      ) : (
        <Table
          testId={`readiness-section-${section.id}`}
          rowTestId="readiness-check"
          rows={section.checks}
          rowKey={(check: ReadinessCheckWire) => check.id}
          columns={[
            {
              header: 'Check',
              cell: (check: ReadinessCheckWire) => (
                <span className="text-xs font-medium text-slate-800" data-check-id={check.id}>
                  {check.label}
                </span>
              ),
            },
            {
              header: 'Status',
              cell: (check: ReadinessCheckWire) => (
                <Badge
                  tone={check.passed ? 'success' : 'danger'}
                  testId="readiness-check-status"
                  mono
                >
                  {check.passed ? 'pass' : 'fail'}
                </Badge>
              ),
            },
            {
              header: 'Weight',
              cell: (check: ReadinessCheckWire) => (
                <span className="font-mono text-xs text-slate-600">{check.weight}</span>
              ),
            },
            {
              header: 'Evidence',
              cell: (check: ReadinessCheckWire) => (
                <span data-testid="readiness-evidence" className="font-mono text-[11px] text-slate-600">
                  {check.evidence}
                </span>
              ),
            },
            {
              header: 'Remediation',
              cell: (check: ReadinessCheckWire) => (
                <span data-testid="readiness-remediation" className="text-xs text-slate-600">
                  {check.remediation}
                </span>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

export default async function ReadinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);

  const [factory, readiness, hooks] = await Promise.all([
    loadFactory(factoryId),
    getOrError<ReadinessReportWire>(`/factories/${encoded}/readiness`),
    getOrError<GuardHooksWire>(`/factories/${encoded}/guard-hooks`),
  ]);
  const factoryName = factoryNameOf(factory, factoryId);
  const report = readiness.data;
  const guardHooks = hooks.data;

  return (
    <div
      data-testid="readiness-page"
      className="mx-auto max-w-6xl space-y-4 px-6 py-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(factory?.alias, factoryName, 'Readiness')}
          </h1>
          <p className="text-sm text-slate-500">
            A deterministic scan of the local checkout and the factory definition: tests, linters,
            typecheck, docs, dev environment, observability, security and task discovery, plus
            factory hygiene. No model call, no shell.
          </p>
          {report ? (
            <p className="text-xs text-slate-500">
              scanned <span data-testid="readiness-root" className="font-mono">{report.root}</span>
              {' · '}
              <TimeAgo testId="readiness-generated-at" value={report.generatedAt} prefix="generated " />
            </p>
          ) : null}
        </div>
        {report ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={readinessTone(report.status)} testId="readiness-score" mono>
              {report.score}/100
            </Badge>
            <Badge tone={readinessTone(report.status)} testId="readiness-status" mono>
              {report.status.replace('_', ' ')}
            </Badge>
          </div>
        ) : null}
      </header>

      {report ? (
        <Card testId="readiness-summary">
          <CardHeader
            title="Summary"
            hint={`Ready at ${report.thresholds.ready}, warn at ${report.thresholds.warn}.`}
          />
          <CardBody className="space-y-2">
            <p className="text-3xl font-semibold text-slate-900" data-testid="readiness-summary-score">
              {report.score}
              <span className="text-base font-normal text-slate-500">/100</span>
            </p>
            <p className="text-sm text-slate-700" data-testid="readiness-summary-status">
              <Badge tone={readinessTone(report.status)}>{report.status.replace('_', ' ')}</Badge>{' '}
              <span className="text-xs text-slate-500">
                thresholds ready ≥ {report.thresholds.ready} · warn ≥ {report.thresholds.warn}
              </span>
            </p>
            <p className="text-sm text-slate-700" data-testid="readiness-summary-text">
              {report.summary}
            </p>
            <p className="text-[11px] text-slate-500">
              Scanned root <span className="font-mono">{report.root}</span> · generated{' '}
              {formatDateTime(report.generatedAt)}
            </p>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          testId="readiness-unavailable"
          title="Readiness unavailable"
          description={
            readiness.error
              ? `The readiness report could not be read (${readiness.error.code}). No score is fabricated.`
              : 'The API did not return a readiness report. No score is fabricated.'
          }
        />
      )}

      {report
        ? report.sections.map((section) => <SectionCard key={section.id} section={section} />)
        : null}

      <Card testId="guard-hooks-card">
        <CardHeader
          title="Guard hooks"
          hint="Pure, fail-closed checks run before a pull request is committed: protected branch, path containment, secret patterns, patch size and binary-file limits."
        />
        <CardBody className="space-y-4">
          {guardHooks ? (
            <>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Declared config and defaults</h3>
                <ConfigTable hooks={guardHooks} />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Recent guard events</h3>
                {guardHooks.recent.length === 0 ? (
                  <EmptyState
                    testId="guard-hooks-empty"
                    title="No guard events recorded"
                    description="A guard result is recorded as guard.checked or guard.failed when a pull request is prepared."
                  />
                ) : (
                  <ul data-testid="guard-events" className="space-y-1">
                    {guardHooks.recent.map((event) => (
                      <GuardEventRow
                        key={`${event.workItemId}:${event.type}:${event.createdAt ?? ''}`}
                        event={event}
                        encoded={encoded}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              testId="guard-hooks-unavailable"
              title="Guard hooks unavailable"
              description={
                hooks.error
                  ? `The guard-hook projection could not be read (${hooks.error.code}).`
                  : 'The API did not return the guard-hook projection.'
              }
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
