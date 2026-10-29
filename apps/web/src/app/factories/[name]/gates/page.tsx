import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { GATE_STAGES, docOf, gateMeaning, type AutomationDoc } from '@/lib/definition';
import type { FactoryDetail, FactoryResources, GateStage } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MERGE_POLICY_NOTES: Record<string, string> = {
  human: 'a human merges every pull request',
  auto_on_green: 'merges automatically once checks are green',
  auto_after_n_approvals: 'merges after the configured number of approvals',
  disabled: 'merging is disabled for this factory',
};

export default async function GatesPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

  const gates = detail?.factory.gates ?? null;
  const stageRows: GateStage[] = gates
    ? GATE_STAGES.map((stage) => gates.stages[stage])
    : [];
  const humanStages = stageRows.filter((row) => row.gate === 'human').length;

  const automations = (resources?.resources ?? []).filter((resource) => resource.kind === 'automation');
  const overrides = automations.flatMap((resource) => {
    const doc = docOf<AutomationDoc>(resource);
    return Object.entries(doc.gates ?? {}).map(([stage, gate]) => ({
      automation: resource.name,
      stage,
      gate,
    }));
  });

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Gates
          </h1>
          <p className="text-sm text-slate-500">
            Every stage resolves through <span className="font-mono">automation → factory → global</span>.
            A gate is <span className="font-mono">human</span>, <span className="font-mono">agent</span> or{' '}
            <span className="font-mono">policy:&lt;name&gt;</span>.
          </p>
        </div>
        {gates ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={gates.fullyAutonomous ? 'warning' : 'success'} testId="gates-autonomy-badge">
              {gates.fullyAutonomous ? 'lights off' : 'lights on'}
            </Badge>
            <Badge tone="neutral" testId="gates-merge-policy-badge">
              merge: {gates.mergePolicy}
            </Badge>
          </div>
        ) : null}
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="gates-readonly-banner" />

      {gates?.fullyAutonomous ? (
        <div
          data-testid="gates-autonomy-warning"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <p className="font-semibold">Fully autonomous — lights off.</p>
          <p className="mt-1 text-xs">
            Every stage resolves to <span className="font-mono">agent</span> and the merge policy is{' '}
            <span className="font-mono">{gates.mergePolicy}</span>. A benchmark non-regression gate is
            required before enabling this in production
            {gates.benchmarkGateRequired ? ' — and this factory reports it as required' : ''}. Until the
            benchmark suite has recorded runs, autonomy is a declaration, not a proven capability.
          </p>
        </div>
      ) : gates ? (
        <div
          data-testid="gates-autonomy-note"
          className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
        >
          <span className="font-semibold">Lights on.</span> {humanStages} of {stageRows.length} stages wait
          for a human. A benchmark gate becomes mandatory only when every stage resolves to{' '}
          <span className="font-mono">agent</span>.
        </div>
      ) : null}

      <Card testId="gates-table-card">
        <CardHeader
          title="Stage gates"
          hint="Resolved for the factory itself; automation overrides are listed below."
        />
        <CardBody className="space-y-3">
          {stageRows.length === 0 ? (
            <EmptyState
              testId="gates-empty"
              title="No gate resolution"
              description="The factory manifest could not be loaded from the API, so gates cannot be resolved."
            />
          ) : (
            <>
              <Table
                testId="gates-table"
                rowTestId="gates-row"
                rows={stageRows}
                rowKey={(row) => row.stage}
                columns={[
                  {
                    header: 'Stage',
                    cell: (row) => (
                      <span data-testid="gates-row-stage" className="font-mono text-xs">
                        {row.stage}
                      </span>
                    ),
                  },
                  {
                    header: 'Resolved gate',
                    cell: (row) => (
                      <span data-testid="gates-row-gate">
                        <Badge tone={row.gate === 'human' ? 'warning' : 'success'} mono>
                          {row.gate}
                        </Badge>
                      </span>
                    ),
                  },
                  {
                    header: 'Resolution source',
                    cell: (row) => (
                      <span data-testid="gates-row-source" className="text-xs text-slate-600">
                        {row.source}
                      </span>
                    ),
                  },
                  {
                    header: 'Meaning',
                    cell: (row) => (
                      <span data-testid="gates-row-meaning" className="text-xs text-slate-600">
                        {gateMeaning(row.gate)}
                      </span>
                    ),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span>Merge policy:</span>
                <span data-testid="gates-merge-policy" className="font-mono text-slate-800">
                  {gates?.mergePolicy}
                </span>
                <span className="text-slate-500">
                  — {MERGE_POLICY_NOTES[gates?.mergePolicy ?? ''] ?? 'unknown policy'}
                </span>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card testId="gates-automation-overrides">
        <CardHeader
          title="Automation overrides"
          hint="An automation may raise or lower a stage gate for the work it starts."
        />
        <CardBody>
          {overrides.length === 0 ? (
            <EmptyState
              testId="gates-automation-overrides-empty"
              title="No automation overrides"
              description="No automation declares its own gates, so every dispatch uses the factory gates above."
            />
          ) : (
            <Table
              testId="gates-automation-table"
              rowTestId="gates-automation-row"
              rows={overrides}
              rowKey={(row) => `${row.automation}:${row.stage}`}
              columns={[
                {
                  header: 'Automation',
                  cell: (row) => (
                    <span className="font-mono text-xs" data-testid="gates-automation-name">
                      {row.automation}
                    </span>
                  ),
                },
                { header: 'Stage', cell: (row) => <span className="font-mono text-xs">{row.stage}</span> },
                {
                  header: 'Gate',
                  cell: (row) => (
                    <Badge tone={row.gate === 'human' ? 'warning' : 'success'} mono>
                      {row.gate}
                    </Badge>
                  ),
                },
              ]}
            />
          )}
        </CardBody>
      </Card>

      <p data-testid="gates-killswitch-note" className="text-xs text-slate-500">
        Gate decisions, escalation timers and the global kill switch (which flips every gate back to{' '}
        <span className="font-mono">human</span>) ship with the Phase 3 factory workflow. Until then, human
        gates are actionable through the Inbox.
      </p>
    </div>
  );
}
