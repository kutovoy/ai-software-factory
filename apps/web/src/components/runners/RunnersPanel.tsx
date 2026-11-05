'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { CopyButton } from '@/components/runs/CopyButton';
import { formatDateTime } from '@/lib/format';
import {
  Meter,
  alertSeverityTone,
  alertStateTone,
  formatNumber,
  hostStatusTone,
  labelPairs,
  ruleCondition,
} from '@/components/runners/RunnerGauges';
import type {
  RunnerAlertRuleWire,
  RunnerAlertWire,
  RunnerEnrollmentWire,
  RunnerHostWire,
  RunnerLabelsWire,
  RunnerPreflightWire,
} from '@/lib/types';

/**
 * Runners console surface (spec `runner-observability` › Console visibility).
 *
 * The MVP runs a Linux runner agent on a remote host: it polls the API outbound with a
 * bearer token, executes the harness locally and reports heartbeats. Nothing here executes
 * a tool — the page enrolls hosts, drains them, and reads the metrics/alerts the agent
 * reported. Windows and macOS agents are a later phase; the platform select says so.
 */

interface FormState {
  name: string;
  platform: string;
  arch: string;
  pool: string;
  labels: string;
  maxConcurrent: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  platform: 'linux',
  arch: 'x64',
  pool: 'default',
  labels: '',
  maxConcurrent: '1',
};

const FIELD =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900';

/** `k=v, k2=v2` → an object; a bare token is a client-side error, never a silent label. */
function parseLabels(raw: string): { labels: RunnerLabelsWire; error: string | null } {
  const labels: RunnerLabelsWire = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return { labels, error: `label "${trimmed}" is not key=value` };
    }
    labels[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return { labels, error: null };
}

function apiError(body: unknown, status: number): string {
  const envelope = body as { code?: string; message?: string };
  return `${envelope.code ? `${envelope.code}: ` : ''}${envelope.message ?? `request failed (${status})`}`;
}

const ALERT_STATE_ORDER: Record<string, number> = {
  firing: 0,
  acknowledged: 1,
  silenced: 2,
  resolved: 3,
};

function sortAlerts(alerts: RunnerAlertWire[]): RunnerAlertWire[] {
  return [...alerts].sort((a, b) => {
    const rank = (ALERT_STATE_ORDER[a.state] ?? 9) - (ALERT_STATE_ORDER[b.state] ?? 9);
    if (rank !== 0) return rank;
    return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '');
  });
}

export function RunnersPanel({
  hosts,
  alerts,
  rules,
}: {
  hosts: RunnerHostWire[];
  alerts: RunnerAlertWire[];
  rules: RunnerAlertRuleWire[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(hosts.length === 0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<RunnerEnrollmentWire | null>(null);
  const [preflight, setPreflight] = useState<RunnerPreflightWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = (): void => {
    setError(null);
    setNotice(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    reset();
    if (!form.name.trim()) {
      setError('a runner name is required');
      return;
    }
    const parsed = parseLabels(form.labels);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const capacity = Number.parseInt(form.maxConcurrent, 10);

    setBusy(true);
    try {
      const response = await fetch('/api/v1/runners/enrollments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          platform: form.platform,
          arch: form.arch,
          pool: form.pool.trim() || undefined,
          labels: Object.keys(parsed.labels).length > 0 ? parsed.labels : undefined,
          maxConcurrent: Number.isFinite(capacity) && capacity > 0 ? capacity : undefined,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        enrollment?: RunnerEnrollmentWire;
        code?: string;
        message?: string;
      };
      if (!response.ok || !body.enrollment) {
        throw new Error(apiError(body, response.status));
      }
      setEnrollment(body.enrollment);
      setPreflight(null);
      setForm(EMPTY_FORM);
      setNotice(
        `Enrollment created for ${body.enrollment.name}. The token is shown once — run the preflight, then the install command on the host.`,
      );
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  const checkPreflight = async (id: string): Promise<void> => {
    reset();
    setPending(`preflight:${id}`);
    try {
      const response = await fetch(`/api/v1/runners/enrollments/${encodeURIComponent(id)}`);
      const body = (await response.json().catch(() => ({}))) as {
        enrollment?: RunnerEnrollmentWire;
        code?: string;
        message?: string;
      };
      if (!response.ok || !body.enrollment) {
        throw new Error(apiError(body, response.status));
      }
      const reported = body.enrollment.preflight ?? null;
      setPreflight(reported);
      setNotice(
        reported
          ? `Preflight reported: ${reported.status}.`
          : 'No preflight reported yet — run the preflight command on the host.',
      );
    } catch (preflightError) {
      setError(preflightError instanceof Error ? preflightError.message : String(preflightError));
    } finally {
      setPending(null);
    }
  };

  const setDrain = async (host: RunnerHostWire, drain: boolean): Promise<void> => {
    reset();
    setPending(`drain:${host.id}`);
    try {
      const response = await fetch(`/api/v1/runners/${encodeURIComponent(host.id)}/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drain }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        host?: RunnerHostWire;
        code?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(apiError(body, response.status));
      setNotice(
        drain
          ? `Draining ${host.name}: no new leases are scheduled; running leases finish.`
          : `Resumed ${host.name}: the scheduler may lease this host again.`,
      );
      router.refresh();
    } catch (drainError) {
      setError(drainError instanceof Error ? drainError.message : String(drainError));
    } finally {
      setPending(null);
    }
  };

  const remove = async (host: RunnerHostWire): Promise<void> => {
    reset();
    setPending(`delete:${host.id}`);
    try {
      const response = await fetch(`/api/v1/runners/${encodeURIComponent(host.id)}`, {
        method: 'DELETE',
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      if (!response.ok) throw new Error(apiError(body, response.status));
      setNotice(`Deleted ${host.name}. Its leases and alert history were removed with it.`);
      setConfirmDelete(null);
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setPending(null);
    }
  };

  const acknowledge = async (alert: RunnerAlertWire): Promise<void> => {
    reset();
    setPending(`ack:${alert.id}`);
    try {
      const response = await fetch(`/api/v1/runner-alerts/${encodeURIComponent(alert.id)}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      if (!response.ok) throw new Error(apiError(body, response.status));
      setNotice(`Acknowledged ${alert.metric} on ${alert.hostName}.`);
      router.refresh();
    } catch (ackError) {
      setError(ackError instanceof Error ? ackError.message : String(ackError));
    } finally {
      setPending(null);
    }
  };

  const silence = async (alert: RunnerAlertWire): Promise<void> => {
    reset();
    setPending(`silence:${alert.id}`);
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    try {
      const response = await fetch(`/api/v1/runner-alerts/${encodeURIComponent(alert.id)}/silence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ until }),
      });
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      if (!response.ok) throw new Error(apiError(body, response.status));
      setNotice(`Silenced ${alert.metric} on ${alert.hostName} for one hour (until ${until}).`);
      router.refresh();
    } catch (silenceError) {
      setError(silenceError instanceof Error ? silenceError.message : String(silenceError));
    } finally {
      setPending(null);
    }
  };

  const sorted = sortAlerts(alerts);
  const activeAlerts = sorted.filter((alert) => alert.state !== 'resolved');
  const resolvedAlerts = sorted.filter((alert) => alert.state === 'resolved');

  const alertActions = (alert: RunnerAlertWire) => (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        data-testid="runner-alert-ack"
        data-alert={alert.id}
        disabled={pending !== null || alert.state !== 'firing'}
        onClick={() => void acknowledge(alert)}
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
      >
        {pending === `ack:${alert.id}` ? 'Acknowledging…' : 'Acknowledge'}
      </button>
      <button
        type="button"
        data-testid="runner-alert-silence"
        data-alert={alert.id}
        disabled={pending !== null || alert.state === 'resolved'}
        onClick={() => void silence(alert)}
        title="Silence for 1 hour"
        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
      >
        {pending === `silence:${alert.id}` ? 'Silencing…' : 'Silence 1h'}
      </button>
    </span>
  );

  return (
    <div data-testid="runners-panel" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="runner-create-toggle"
          onClick={() => {
            setOpen((value) => !value);
            reset();
          }}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {open ? 'Close' : 'Add runner'}
        </button>
        <span className="text-xs text-slate-500">
          Enrollment issues a one-time token, a preflight command and an install command.
        </span>
      </div>

      {error ? (
        <p data-testid="runner-form-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="runner-form-notice" className="text-xs text-emerald-700">
          {notice}
        </p>
      ) : null}

      {open ? (
        <form
          data-testid="runner-create-form"
          onSubmit={(event) => void submit(event)}
          className="space-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-600">
              Name
              <input
                data-testid="runner-create-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="build-01"
                className={FIELD}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Unique across hosts; the scheduler addresses the host by it.
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Platform
              <select
                data-testid="runner-create-platform"
                value={form.platform}
                onChange={(event) => setForm({ ...form, platform: event.target.value })}
                className={FIELD}
              >
                <option value="linux">linux</option>
                <option value="windows" disabled>
                  windows (later)
                </option>
                <option value="macos" disabled>
                  macos (later)
                </option>
              </select>
              <span className="mt-1 block text-[11px] text-slate-500">
                The MVP agent is Linux-only; Windows/macOS are a later phase.
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Arch
              <select
                data-testid="runner-create-arch"
                value={form.arch}
                onChange={(event) => setForm({ ...form, arch: event.target.value })}
                className={FIELD}
              >
                <option value="x64">x64</option>
                <option value="arm64">arm64</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Pool
              <input
                data-testid="runner-create-pool"
                value={form.pool}
                onChange={(event) => setForm({ ...form, pool: event.target.value })}
                placeholder="default"
                className={FIELD}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                A run matches hosts by platform + pool + labels.
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Labels
              <input
                data-testid="runner-create-labels"
                value={form.labels}
                onChange={(event) => setForm({ ...form, labels: event.target.value })}
                placeholder="gpu=none,zone=eu"
                className={FIELD}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Comma-separated <span className="font-mono">key=value</span> pairs.
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Max concurrency
              <input
                data-testid="runner-create-max"
                type="number"
                min={1}
                max={32}
                value={form.maxConcurrent}
                onChange={(event) => setForm({ ...form, maxConcurrent: event.target.value })}
                className={FIELD}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Simultaneous leases the host may hold.
              </span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="runner-create-submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create enrollment'}
            </button>
            <span className="text-[11px] text-slate-500">
              The token is returned once and never shown again; only its hash is stored.
            </span>
          </div>
        </form>
      ) : null}

      {enrollment ? (
        <div
          data-testid="runner-enrollment"
          data-enrollment-id={enrollment.id}
          className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-slate-900">
              Enrollment <span className="font-mono text-xs">{enrollment.id}</span>
            </p>
            <Badge tone={enrollment.usedAt ? 'success' : 'info'} testId="runner-enrollment-state">
              {enrollment.usedAt ? 'used' : 'awaiting install'}
            </Badge>
            <span className="text-xs text-slate-600" data-testid="runner-enrollment-expires">
              expires {formatDateTime(enrollment.expiresAt)}
            </span>
          </div>

          {enrollment.token ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-700">One-time token</span>
              <code
                data-testid="runner-enrollment-token"
                className="break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-800 ring-1 ring-slate-200"
              >
                {enrollment.token}
              </code>
              <CopyButton value={enrollment.token} testId="runner-enrollment-token-copy" />
              <span className="text-[11px] text-amber-700">
                Copy it now — the API keeps only a hash and cannot show it again.
              </span>
            </div>
          ) : null}

          {enrollment.preflightCommand ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">1 · Preflight (on the host)</span>
                <CopyButton
                  value={enrollment.preflightCommand}
                  testId="runner-preflight-command-copy"
                />
                <button
                  type="button"
                  data-testid="runner-preflight-check"
                  disabled={pending !== null}
                  onClick={() => void checkPreflight(enrollment.id)}
                  className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-slate-600 disabled:opacity-50"
                >
                  {pending === `preflight:${enrollment.id}` ? 'checking…' : 'check status'}
                </button>
              </div>
              <pre
                data-testid="runner-preflight-command"
                className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100"
              >
                {enrollment.preflightCommand}
              </pre>
            </div>
          ) : null}

          {enrollment.installCommand ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">2 · Install the agent</span>
                <CopyButton value={enrollment.installCommand} testId="runner-install-command-copy" />
              </div>
              <pre
                data-testid="runner-install-command"
                className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100"
              >
                {enrollment.installCommand}
              </pre>
            </div>
          ) : null}

          <div className="space-y-1" data-testid="runner-preflight-status">
            {preflight ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-700">Preflight</span>
                  <Badge tone={['pass', 'passed', 'ok'].includes(preflight.status) ? 'success' : 'warning'}>
                    {preflight.status || 'reported'}
                  </Badge>
                  {preflight.checkedAt ? (
                    <span className="text-[11px] text-slate-500">
                      {formatDateTime(preflight.checkedAt)}
                    </span>
                  ) : null}
                </div>
                {Array.isArray(preflight.checks) && preflight.checks.length > 0 ? (
                  <ul className="space-y-0.5 text-[11px] text-slate-700">
                    {preflight.checks.map((check) => (
                      <li key={check.id} data-testid="runner-preflight-check-row" data-ok={check.ok ? 'true' : 'false'}>
                        <span className={check.ok ? 'text-emerald-700' : 'text-red-700'}>
                          {check.ok ? 'pass' : 'fail'}
                        </span>{' '}
                        <span className="font-mono">{check.label ?? check.id}</span>
                        {check.detail ? <span className="text-slate-500"> · {check.detail}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preflight.message ? <p className="text-[11px] text-slate-600">{preflight.message}</p> : null}
              </>
            ) : (
              <p className="text-[11px] text-slate-500">
                No preflight reported yet. Run the preflight command on the host, then check the status.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {hosts.length === 0 ? (
        <EmptyState
          testId="runners-empty"
          title="No runners enrolled"
          description="A remote runner is a host that runs the harness itself and polls this API over outbound HTTPS with a bearer token. Add one to see its heartbeat, CPU/RAM/disk load, leases and alerts here."
        />
      ) : (
        <Table
          testId="runners-hosts"
          rowTestId="runner-host-row"
          rows={hosts}
          rowKey={(host) => host.id}
          columns={[
            {
              header: 'Host',
              cell: (host) => (
                <div className="min-w-0 space-y-0.5" data-host-id={host.id}>
                  <Link
                    href={`/runners/${encodeURIComponent(host.id)}`}
                    data-testid="runner-host-link"
                    className="block truncate text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                  >
                    {host.name}
                  </Link>
                  <p className="truncate font-mono text-[11px] text-slate-500">
                    {host.platform}/{host.arch} · {host.agentVersion ?? 'agent version unknown'}
                  </p>
                </div>
              ),
            },
            {
              header: 'Pool / labels',
              cell: (host) => (
                <div className="space-y-0.5">
                  <p className="font-mono text-xs text-slate-700" data-testid="runner-host-pool">
                    {host.pool}
                  </p>
                  {labelPairs(host.labels).length > 0 ? (
                    <p className="text-[11px] text-slate-500" data-testid="runner-host-labels">
                      {labelPairs(host.labels).join(', ')}
                    </p>
                  ) : (
                    <p className="text-[11px] text-slate-400">no labels</p>
                  )}
                </div>
              ),
            },
            {
              header: 'Status',
              cell: (host) => (
                <span className="flex flex-wrap gap-1">
                  <Badge tone={hostStatusTone(host.status)} testId="runner-host-status">
                    {host.status}
                  </Badge>
                  {host.drain ? (
                    <Badge tone="warning" testId="runner-host-drain">
                      draining
                    </Badge>
                  ) : null}
                </span>
              ),
            },
            {
              header: 'Heartbeat',
              cell: (host) => (
                <span className="text-xs text-slate-600" data-testid="runner-host-heartbeat">
                  <TimeAgo value={host.lastHeartbeat} />
                </span>
              ),
            },
            {
              header: 'Load',
              cell: (host) => (
                <div className="flex flex-wrap gap-3" data-testid="runner-host-load">
                  <Meter compact label="CPU" value={host.cpuPercent} />
                  <Meter compact label="RAM" value={host.memoryUsedPercent} />
                  <Meter compact label="Disk" value={host.diskUsedPercent} />
                </div>
              ),
            },
            {
              header: 'Leases',
              cell: (host) => (
                <span className="font-mono text-xs text-slate-700" data-testid="runner-host-leases">
                  {host.activeLeases} / {host.maxConcurrent}
                </span>
              ),
            },
            {
              header: 'Alerts',
              cell: (host) => (
                <Badge
                  tone={host.alertCount > 0 ? 'danger' : 'neutral'}
                  testId="runner-host-alerts"
                >
                  {host.alertCount}
                </Badge>
              ),
            },
            {
              header: 'Actions',
              cell: (host) => (
                <span className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="runner-host-drain-toggle"
                    data-host={host.id}
                    disabled={pending !== null}
                    onClick={() => void setDrain(host, !host.drain)}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    {pending === `drain:${host.id}` ? 'Saving…' : host.drain ? 'Resume' : 'Drain'}
                  </button>
                  <button
                    type="button"
                    data-testid="runner-host-delete"
                    data-host={host.id}
                    disabled={pending !== null}
                    onClick={() => {
                      reset();
                      if (confirmDelete === host.id) void remove(host);
                      else setConfirmDelete(host.id);
                    }}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                  >
                    {pending === `delete:${host.id}`
                      ? 'Deleting…'
                      : confirmDelete === host.id
                        ? 'Confirm delete'
                        : 'Delete'}
                  </button>
                </span>
              ),
            },
          ]}
        />
      )}

      <section data-testid="runner-alerts-section" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Alerts</h2>
          <span className="text-xs text-slate-500">
            {activeAlerts.length} active · {resolvedAlerts.length} resolved
          </span>
        </div>
        {activeAlerts.length === 0 ? (
          <EmptyState
            testId="runner-alerts-empty"
            title="No firing alerts"
            description="Threshold rules are evaluated on every heartbeat. A metric below its threshold (or a host that keeps heartbeating) produces no alert — this is the healthy state, not missing data."
          />
        ) : (
          <Table
            testId="runner-alerts"
            rowTestId="runner-alert-row"
            rows={activeAlerts}
            rowKey={(alert) => alert.id}
            columns={[
              {
                header: 'Severity',
                cell: (alert) => (
                  <Badge tone={alertSeverityTone(alert.severity)} testId="runner-alert-severity">
                    {alert.severity}
                  </Badge>
                ),
              },
              {
                header: 'State',
                cell: (alert) => (
                  <Badge tone={alertStateTone(alert.state)} testId="runner-alert-state">
                    {alert.state}
                  </Badge>
                ),
              },
              {
                header: 'Host',
                cell: (alert) => (
                  <Link
                    href={`/runners/${encodeURIComponent(alert.hostId)}`}
                    data-testid="runner-alert-host"
                    className="text-xs font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                  >
                    {alert.hostName}
                  </Link>
                ),
              },
              {
                header: 'Metric',
                cell: (alert) => (
                  <span className="space-y-0.5">
                    <span className="block font-mono text-xs text-slate-800" data-testid="runner-alert-metric">
                      {alert.metric} = {formatNumber(alert.value)}
                    </span>
                    <span className="block text-[11px] text-slate-500">rule {alert.ruleId}</span>
                  </span>
                ),
              },
              {
                header: 'Message',
                cell: (alert) => (
                  <span className="block max-w-[28rem] text-xs text-slate-700" data-testid="runner-alert-message">
                    {alert.message}
                  </span>
                ),
              },
              {
                header: 'Last seen',
                cell: (alert) => (
                  <span className="text-xs text-slate-600" data-testid="runner-alert-last-seen">
                    <TimeAgo value={alert.lastSeen} />
                  </span>
                ),
              },
              { header: 'Actions', cell: alertActions },
            ]}
          />
        )}

        {resolvedAlerts.length > 0 ? (
          <details data-testid="runner-alerts-resolved" className="rounded-lg border border-slate-200 bg-white">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">
              Resolved history ({resolvedAlerts.length})
            </summary>
            <ul className="divide-y divide-slate-100">
              {resolvedAlerts.map((alert) => (
                <li
                  key={alert.id}
                  data-testid="runner-alert-resolved-row"
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-slate-600"
                >
                  <Badge tone={alertSeverityTone(alert.severity)}>{alert.severity}</Badge>
                  <span className="font-mono">{alert.metric} = {formatNumber(alert.value)}</span>
                  <span>{alert.hostName}</span>
                  <span className="text-slate-500">{alert.message}</span>
                  <span className="ml-auto">
                    resolved <TimeAgo value={alert.resolvedAt} />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <details data-testid="runner-alert-rules" className="rounded-lg border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-700">
          Alert rules ({rules.length}) — read-only here; edit through the API
        </summary>
        {rules.length === 0 ? (
          <p className="px-3 py-2 text-xs text-slate-500">
            No rules returned. The API seeds a default global set on migration; an empty list
            means no thresholds are being evaluated.
          </p>
        ) : (
          <Table
            testId="runner-alert-rules-table"
            rowTestId="runner-alert-rule-row"
            rows={rules}
            rowKey={(rule) => rule.id}
            columns={[
              { header: 'Rule', cell: (rule) => <span className="font-mono text-xs text-slate-800">{rule.id}</span> },
              { header: 'Scope', cell: (rule) => <span className="text-xs">{rule.scope}{rule.pool ? ` · ${rule.pool}` : ''}</span> },
              {
                header: 'Condition',
                cell: (rule) => (
                  <span className="font-mono text-xs text-slate-700" data-testid="runner-alert-rule-condition">
                    {ruleCondition(rule)}
                  </span>
                ),
              },
              {
                header: 'Severity',
                cell: (rule) => <Badge tone={alertSeverityTone(rule.severity)}>{rule.severity}</Badge>,
              },
              { header: 'Channel', cell: (rule) => <span className="text-xs">{rule.channel}</span> },
              {
                header: 'Enabled',
                cell: (rule) => <Badge tone={rule.enabled ? 'success' : 'neutral'}>{rule.enabled ? 'on' : 'off'}</Badge>,
              },
            ]}
          />
        )}
      </details>

      <p className="text-[11px] text-slate-500" data-testid="runner-console-note">
        A gauge with no value means the agent has not reported that metric yet — not 0%.
        Alerts are evaluated centrally from the heartbeat samples; the console only displays
        and acknowledges them.
      </p>
    </div>
  );
}
