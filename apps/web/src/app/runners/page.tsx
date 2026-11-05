import { RunnersPanel } from '@/components/runners/RunnersPanel';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { safeGet } from '@/lib/api';
import type {
  RunnerAlertRulesResponseWire,
  RunnerAlertsResponseWire,
  RunnersResponseWire,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Runners (change `add-remote-runners`, spec `runner-observability` › Console visibility).
 *
 * A remote runner is a host that runs the harness itself, polls the API outbound with a
 * bearer token and reports heartbeats. This page is the operator surface: enroll a host,
 * read its CPU/RAM/disk load, leases and alerts, drain it, or delete it.
 *
 * Degraded mode follows the console convention (`safeGet`): when the API is unreachable the
 * shell still renders with empty projections instead of failing the page.
 */

const EMPTY_RUNNERS: RunnersResponseWire = { hosts: [] };
const EMPTY_ALERTS: RunnerAlertsResponseWire = { alerts: [] };
const EMPTY_RULES: RunnerAlertRulesResponseWire = { rules: [] };

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string | number;
  hint?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-0.5 text-xl font-semibold text-slate-900">{value}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default async function RunnersPage() {
  const [runners, alerts, rules] = await Promise.all([
    safeGet<RunnersResponseWire>('/runners', EMPTY_RUNNERS),
    safeGet<RunnerAlertsResponseWire>('/runner-alerts', EMPTY_ALERTS),
    safeGet<RunnerAlertRulesResponseWire>('/runner-alert-rules', EMPTY_RULES),
  ]);

  const hosts = runners.hosts ?? [];
  const alertList = alerts.alerts ?? [];
  const ruleList = rules.rules ?? [];

  const ready = hosts.filter((host) => host.status === 'ready' && !host.drain).length;
  const draining = hosts.filter((host) => host.drain).length;
  const unreachable = hosts.filter(
    (host) => host.status === 'unreachable' || host.status === 'error',
  ).length;
  const activeAlerts = alertList.filter((alert) => alert.state !== 'resolved').length;
  const leases = hosts.reduce((sum, host) => sum + (host.activeLeases ?? 0), 0);
  const capacity = hosts.reduce((sum, host) => sum + (host.maxConcurrent ?? 0), 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Runners</h1>
          <p className="text-sm text-slate-500">
            Remote hosts that execute harness runs outside this process. The agent polls the
            API outbound with a bearer token, runs the sandbox locally and reports metrics and
            alerts; this page never executes a tool.
          </p>
        </div>
      </header>

      <p className="text-xs text-slate-500" data-testid="runners-note">
        Linux MVP: the agent ships for Linux hosts only, runs the harness adapter on the host,
        and is authenticated by a bearer token — TLS termination is expected at the central
        edge. Windows and macOS agents are a later phase. Hosts that stop heartbeating are
        marked <span className="font-mono">unreachable</span> and raise a heartbeat alert.
      </p>

      <section data-testid="runners-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          testId="runners-summary-ready"
          label="Ready"
          value={ready}
          hint={`${hosts.length} enrolled · ${draining} draining · ${unreachable} unreachable`}
        />
        <Stat
          testId="runners-summary-leases"
          label="Active leases"
          value={leases}
          hint={`${capacity} concurrent slot${capacity === 1 ? '' : 's'} declared`}
        />
        <Stat
          testId="runners-summary-alerts"
          label="Active alerts"
          value={activeAlerts}
          hint={`${alertList.length} total · ${ruleList.length} rules evaluated`}
        />
        <Stat
          testId="runners-summary-pools"
          label="Pools"
          value={new Set(hosts.map((host) => host.pool)).size}
          hint="A run matches hosts by platform, pool, labels and free capacity"
        />
      </section>

      <Card testId="runners-hosts-card">
        <CardHeader
          title="Runner hosts"
          hint="Status, last heartbeat, load from the newest sample, leases and alert count. Drain keeps running leases and stops new ones."
        />
        <CardBody>
          <RunnersPanel hosts={hosts} alerts={alertList} rules={ruleList} />
        </CardBody>
      </Card>
    </div>
  );
}
