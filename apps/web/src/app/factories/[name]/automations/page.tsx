import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { describeTrigger, docOf, type AutomationDoc } from '@/lib/definition';
import type { FactoryDetail, FactoryResources } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

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
        <Badge tone="neutral" testId="automations-count">
          {automations.length} automations
        </Badge>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="automations-readonly-banner" />

      <div
        data-testid="automations-phase-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">Dispatch runs in Phase 3.</span> This page shows what git declares —
        triggers, agent and gate overrides. No automation has been triggered from the console, and no last-run
        timestamps exist yet.
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
