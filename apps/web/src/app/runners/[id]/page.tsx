import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { TimeAgo } from '@/components/ui/TimeAgo';
import {
  Meter,
  Sparkline,
  alertSeverityTone,
  alertStateTone,
  formatNumber,
  hostStatusTone,
  labelPairs,
  leaseStateTone,
} from '@/components/runners/RunnerGauges';
import { getOrError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { RunnerDetailResponseWire, RunnerMetricSampleWire } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Ascending by capture time, so the sparkline reads oldest → newest whatever the API order. */
function samplesAscending(samples: RunnerMetricSampleWire[]): RunnerMetricSampleWire[] {
  return [...samples].sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
}

function seriesOf(
  samples: RunnerMetricSampleWire[],
  key: 'cpuPercent' | 'memoryUsedPercent' | 'diskUsedPercent',
): number[] {
  return samples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function metricValue(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : formatNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}

/**
 * Runner host detail (change `add-remote-runners`, spec `runner-observability` › Host metrics).
 *
 * Everything is a projection of what the agent reported: the newest heartbeat drives the
 * gauges, the stored samples drive the sparklines, and a metric the agent never sent stays
 * `—` instead of becoming a zero. A host that no longer exists is a 404, not an empty page.
 */
export default async function RunnerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runnerId = decodeURIComponent(id);

  const result = await getOrError<RunnerDetailResponseWire>(
    `/runners/${encodeURIComponent(runnerId)}`,
  );
  if (result.error?.status === 404) notFound();

  if (result.error || !result.data) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Link
            href="/runners"
            className="text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2"
          >
            ← Runners
          </Link>
          <h1 className="text-lg font-semibold text-slate-900">Runner host</h1>
        </header>
        <EmptyState
          testId="runner-detail-unavailable"
          title="This runner host is unavailable"
          description={
            result.error
              ? `The API did not return the host: ${result.error.code ? `${result.error.code} — ` : ''}${result.error.message}`
              : 'The API returned no host for this id.'
          }
        />
      </div>
    );
  }

  const { host } = result.data;
  const samples = samplesAscending(result.data.metrics ?? []);
  const leases = result.data.leases ?? [];
  const alerts = result.data.alerts ?? [];
  const latestSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const rawMetrics = latestSample?.metrics ?? host.metrics ?? null;
  const labels = labelPairs(host.labels);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/runners"
              data-testid="runner-detail-back"
              className="text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-2"
            >
              ← Runners
            </Link>
            <h1 className="text-lg font-semibold text-slate-900" data-testid="runner-detail-name">
              {host.name}
            </h1>
            <Badge tone={hostStatusTone(host.status)} testId="runner-detail-status">
              {host.status}
            </Badge>
            {host.drain ? (
              <Badge tone="warning" testId="runner-detail-drain">
                draining
              </Badge>
            ) : null}
          </div>
          <p className="font-mono text-xs text-slate-500" data-testid="runner-detail-id">
            {host.id}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p data-testid="runner-detail-heartbeat">
            last heartbeat <TimeAgo value={host.lastHeartbeat} />
          </p>
          <p data-testid="runner-detail-enrolled">
            enrolled {formatDateTime(host.enrolledAt)}
          </p>
        </div>
      </header>

      <Card testId="runner-detail-meta">
        <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="platform">
            <p className="text-xs uppercase tracking-wide text-slate-400">Platform / arch</p>
            <p className="truncate font-mono text-sm text-slate-800">
              {host.platform}/{host.arch}
            </p>
          </div>
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="pool">
            <p className="text-xs uppercase tracking-wide text-slate-400">Pool</p>
            <p className="truncate font-mono text-sm text-slate-800" data-testid="runner-detail-pool">
              {host.pool}
            </p>
          </div>
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="leases">
            <p className="text-xs uppercase tracking-wide text-slate-400">Leases</p>
            <p className="truncate font-mono text-sm text-slate-800" data-testid="runner-detail-lease-count">
              {host.activeLeases} / {host.maxConcurrent}
            </p>
          </div>
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="agent">
            <p className="text-xs uppercase tracking-wide text-slate-400">Agent</p>
            <p className="truncate font-mono text-sm text-slate-800" data-testid="runner-detail-agent-version">
              {host.agentVersion ?? 'unknown'}
            </p>
          </div>
          <div className="min-w-0 md:col-span-2" data-testid="runner-meta-cell" data-meta="labels">
            <p className="text-xs uppercase tracking-wide text-slate-400">Labels</p>
            <p className="text-xs text-slate-700" data-testid="runner-detail-labels">
              {labels.length > 0 ? labels.join(', ') : 'no labels declared'}
            </p>
          </div>
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="tenant">
            <p className="text-xs uppercase tracking-wide text-slate-400">Owner / tenant</p>
            <p className="truncate text-sm text-slate-800">
              {host.owner ?? '—'} · {host.tenant}
            </p>
          </div>
          <div className="min-w-0" data-testid="runner-meta-cell" data-meta="alerts">
            <p className="text-xs uppercase tracking-wide text-slate-400">Active alerts</p>
            <p className="text-sm text-slate-800" data-testid="runner-detail-alert-count">
              {host.alertCount}
            </p>
          </div>
        </CardBody>
      </Card>

      <Card testId="runner-detail-gauges">
        <CardHeader
          title="Load"
          hint={
            samples.length > 0
              ? `${samples.length} heartbeat sample${samples.length === 1 ? '' : 's'} in the window; the bar is the newest value.`
              : 'No heartbeat samples stored yet — the gauges stay empty rather than showing a zero.'
          }
        />
        <CardBody className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-2">
            <Meter label="CPU" value={host.cpuPercent} testId="runner-gauge-cpu" />
            <Sparkline label="CPU" values={seriesOf(samples, 'cpuPercent')} testId="runner-sparkline-cpu" />
          </div>
          <div className="space-y-2">
            <Meter label="RAM" value={host.memoryUsedPercent} testId="runner-gauge-memory" />
            <Sparkline
              label="RAM"
              values={seriesOf(samples, 'memoryUsedPercent')}
              testId="runner-sparkline-memory"
            />
          </div>
          <div className="space-y-2">
            <Meter label="Disk" value={host.diskUsedPercent} testId="runner-gauge-disk" />
            <Sparkline label="Disk" values={seriesOf(samples, 'diskUsedPercent')} testId="runner-sparkline-disk" />
          </div>
        </CardBody>
      </Card>

      {rawMetrics && Object.keys(rawMetrics).length > 0 ? (
        <details data-testid="runner-detail-raw-metrics" className="rounded-xl border border-slate-200 bg-white">
          <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-slate-900">
            Reported metrics ({Object.keys(rawMetrics).length})
          </summary>
          <div className="px-5 pb-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
              {Object.entries(rawMetrics).map(([key, value]) => (
                <div key={key} className="flex min-w-0 justify-between gap-2" data-testid="runner-raw-metric">
                  <dt className="truncate font-mono text-slate-500" title={key}>
                    {key}
                  </dt>
                  <dd className="truncate font-mono text-slate-800" title={metricValue(value)}>
                    {metricValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-[11px] text-slate-500">
              The raw heartbeat payload from {latestSample ? formatDateTime(latestSample.capturedAt) : 'the host record'}.
              Unknown counters are shown verbatim — the console does not invent units.
            </p>
          </div>
        </details>
      ) : null}

      <Card testId="runner-detail-leases">
        <CardHeader
          title="Leases"
          hint="A lease reserves one concurrency slot; it is released when the run is killed or expires."
          action={<Badge tone="neutral">{leases.length}</Badge>}
        />
        <Table
          testId="runner-leases"
          rowTestId="runner-lease-row"
          rows={leases}
          rowKey={(lease) => lease.id}
          empty={
            <p data-testid="runner-leases-empty" className="px-5 py-4 text-sm text-slate-500">
              No leases held by this host. That is the idle state, not missing data.
            </p>
          }
          columns={[
            {
              header: 'Lease',
              cell: (lease) => <span className="font-mono text-xs text-slate-800">{lease.id}</span>,
            },
            {
              header: 'Run',
              cell: (lease) => (
                <span className="font-mono text-xs text-slate-700" data-testid="runner-lease-run">
                  {lease.runId}
                </span>
              ),
            },
            {
              header: 'Runner',
              cell: (lease) => <span className="font-mono text-xs text-slate-700">{lease.runnerId}</span>,
            },
            {
              header: 'State',
              cell: (lease) => <Badge tone={leaseStateTone(lease.state)}>{lease.state}</Badge>,
            },
            {
              header: 'Created',
              cell: (lease) => <span className="text-xs text-slate-600">{formatDateTime(lease.createdAt)}</span>,
            },
            {
              header: 'Expires',
              cell: (lease) => <span className="text-xs text-slate-600">{formatDateTime(lease.expiresAt)}</span>,
            },
            {
              header: 'Heartbeat',
              cell: (lease) => (
                <span className="text-xs text-slate-600">
                  <TimeAgo value={lease.lastHeartbeat} />
                </span>
              ),
            },
          ]}
        />
      </Card>

      <Card testId="runner-detail-alerts">
        <CardHeader
          title="Alerts"
          hint="Thresholds evaluated centrally from this host's heartbeat samples. Acknowledge or silence them on the Runners page."
          action={<Badge tone={alerts.some((alert) => alert.state === 'firing') ? 'danger' : 'neutral'}>{alerts.length}</Badge>}
        />
        <Table
          testId="runner-alerts"
          rowTestId="runner-alert-row"
          rows={alerts}
          rowKey={(alert) => alert.id}
          empty={
            <p data-testid="runner-detail-alerts-empty" className="px-5 py-4 text-sm text-slate-500">
              No alerts recorded for this host.
            </p>
          }
          columns={[
            {
              header: 'Severity',
              cell: (alert) => <Badge tone={alertSeverityTone(alert.severity)}>{alert.severity}</Badge>,
            },
            {
              header: 'State',
              cell: (alert) => <Badge tone={alertStateTone(alert.state)}>{alert.state}</Badge>,
            },
            {
              header: 'Metric',
              cell: (alert) => (
                <span className="font-mono text-xs text-slate-800" data-testid="runner-alert-metric">
                  {alert.metric} = {formatNumber(alert.value)}
                </span>
              ),
            },
            {
              header: 'Message',
              cell: (alert) => <span className="text-xs text-slate-700">{alert.message}</span>,
            },
            {
              header: 'First seen',
              cell: (alert) => <span className="text-xs text-slate-600">{formatDateTime(alert.firstSeen)}</span>,
            },
            {
              header: 'Last seen',
              cell: (alert) => (
                <span className="text-xs text-slate-600">
                  <TimeAgo value={alert.lastSeen} />
                </span>
              ),
            },
            {
              header: 'Acknowledged',
              cell: (alert) => (
                <span className="text-xs text-slate-600" data-testid="runner-alert-acknowledged">
                  {alert.acknowledgedAt
                    ? `${alert.acknowledgedBy ?? 'unknown'} · ${formatDateTime(alert.acknowledgedAt)}`
                    : '—'}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <p className="text-[11px] text-slate-500">
        Metrics come from the agent&apos;s heartbeat; the API stores them and evaluates the rules.
        A host that stops heartbeating turns <span className="font-mono">unreachable</span> and
        raises a heartbeat-age alert — the last reported sample stays visible, it is not deleted.
      </p>
    </div>
  );
}
