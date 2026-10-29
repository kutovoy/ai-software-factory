import { AutomationSyncButton } from '@/components/automations/AutomationSyncButton';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { describeTrigger, docOf, type AutomationDoc } from '@/lib/definition';
import type {
  AutomationsResponseWire,
  AutomationViewWire,
  FactoryDetail,
  FactoryResources,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources, wiring] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
    safeGet<AutomationsResponseWire | null>(`/factories/${encoded}/automations`, null),
  ]);
  const wiringByName = new Map<string, AutomationViewWire>(
    (wiring?.automations ?? []).map((entry) => [entry.name, entry]),
  );

  const automations = (resources?.resources ?? [])
    .filter((resource) => resource.kind === 'automation')
    .map((resource) => ({ resource, doc: docOf<AutomationDoc>(resource) }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Automations
          </h1>
          <p className="text-sm text-slate-500">
            First-class entry points: which events start work, which agent handles it, and which gates it
            can override.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" testId="automations-count">
            {automations.length} automations
          </Badge>
          <AutomationSyncButton factory={factory} />
        </div>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="automations-readonly-banner" />

      <div
        data-testid="automations-webhook"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">Webhook:</span>{' '}
        <span data-testid="automations-webhook-url" className="break-all font-mono text-xs">
          {wiring?.webhook.url ?? '—'}
        </span>{' '}
        · secret ref{' '}
        <span data-testid="automations-webhook-secret" className="font-mono text-xs">
          {wiring?.webhook.secretRef ?? '—'}
        </span>
        <span className="mt-1 block text-xs text-slate-500">
          Deliveries are verified with <span className="font-mono">X-Hub-Signature-256</span>, deduped by{' '}
          <span className="font-mono">X-GitHub-Delivery</span>, and bot senders are skipped by default. Payload
          text reaches an agent framed as untrusted data.
        </span>
      </div>

      <Card testId="automations-list">
        <CardHeader title="Declared automations" hint="automations/<name>/automation.md" />
        <CardBody>
          {automations.length === 0 ? (
            <EmptyState
              testId="automations-empty"
              title="No automations declared"
              description="The definition has no resources under automations/."
            />
          ) : (
            <Table
              testId="automations-table"
              rowTestId="automation-row"
              rows={automations}
              rowKey={(row) => row.resource.path}
              columns={[
                {
                  header: 'Automation',
                  cell: (row) => (
                    <span className="block">
                      <span className="font-mono text-xs font-medium text-slate-900">
                        {row.doc.displayName ?? row.resource.name}
                      </span>
                      <span className="block text-xs text-slate-500">{row.resource.summary}</span>
                    </span>
                  ),
                },
                {
                  header: 'Agent',
                  cell: (row) => (
                    <span data-testid="automation-agent" className="font-mono text-xs text-slate-700">
                      {row.doc.agent ?? '—'}
                    </span>
                  ),
                },
                {
                  header: 'Triggers',
                  cell: (row) => (
                    <ul data-testid="automation-triggers" className="space-y-0.5">
                      {(row.doc.triggers ?? []).map((trigger, index) => (
                        <li key={index} className="font-mono text-[11px] text-slate-600">
                          {describeTrigger(trigger)}
                        </li>
                      ))}
                    </ul>
                  ),
                },
                {
                  header: 'Gate overrides',
                  cell: (row) => {
                    const overrides = Object.entries(row.doc.gates ?? {});
                    return (
                      <span data-testid="automation-gate-overrides">
                        {overrides.length === 0 ? (
                          <span className="text-xs text-slate-400">none</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {overrides.map(([stage, gate]) => (
                              <Badge key={stage} tone={gate === 'human' ? 'warning' : 'success'} mono>
                                {stage}: {gate}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </span>
                    );
                  },
                },
                {
                  header: 'Enabled',
                  cell: (row) => (
                    <span data-testid="automation-enabled">
                      <Badge tone={row.doc.enabled === false ? 'neutral' : 'success'}>
                        {row.doc.enabled === false ? 'disabled' : 'enabled'}
                      </Badge>
                    </span>
                  ),
                },
                {
                  header: 'Cron schedule',
                  cell: (row) => {
                    const wired = wiringByName.get(row.resource.name);
                    const schedule = wired?.schedule ?? null;
                    if (!wired?.cron) {
                      return (
                        <span data-testid="automation-schedule-none" className="text-xs text-slate-400">
                          no schedule
                        </span>
                      );
                    }
                    return (
                      <span className="block">
                        <span data-testid="automation-schedule-status" data-status={schedule?.status ?? 'pending'}>
                          <Badge
                            tone={
                              schedule?.status === 'active'
                                ? 'success'
                                : schedule?.status === 'paused'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {schedule?.status ?? 'pending'}
                          </Badge>
                        </span>
                        <span className="block font-mono text-[11px] text-slate-600">{wired.cron}</span>
                        <span data-testid="automation-last-fire" className="block text-[11px] text-slate-500">
                          last fire: {schedule?.lastFireAt ?? 'never'}
                          {schedule?.fireCount ? ` · ${schedule.fireCount} fire(s)` : ''}
                        </span>
                      </span>
                    );
                  },
                },
                {
                  header: 'Webhook',
                  cell: (row) => {
                    const wired = wiringByName.get(row.resource.name);
                    const webhook = wired?.webhook;
                    if (!wired || wired.webhookEvents.length === 0) {
                      return (
                        <span data-testid="automation-webhook-none" className="text-xs text-slate-400">
                          not webhook-driven
                        </span>
                      );
                    }
                    return (
                      <span className="block text-[11px] text-slate-600">
                        <span data-testid="automation-webhook-events" className="block font-mono">
                          {wired.webhookEvents.join(', ')}
                        </span>
                        <span data-testid="automation-webhook-deliveries">
                          {webhook?.deliveries ?? 0} delivery(s) · {webhook?.accepted ?? 0} accepted
                        </span>
                        <span data-testid="automation-webhook-last" className="block text-slate-500">
                          last: {webhook?.lastDeliveryAt ?? 'never'}
                        </span>
                      </span>
                    );
                  },
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-500">
        Triggers arrive from GitHub, GitLab, Linear, Jira, Slack, Teams, webhooks, schedules or the factory
        itself; the definition is the only source for them.
      </p>
    </div>
  );
}
