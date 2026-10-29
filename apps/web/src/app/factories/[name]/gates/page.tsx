import { AutonomyControl } from '@/components/factory/AutonomyControl';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { GATE_STAGES, docOf, gateMeaning, type AutomationDoc } from '@/lib/definition';
import type {
  BenchmarkGateStatusWire,
  FactoryDetail,
  FactoryResources,
  GateStage,
  WorkItemDetail,
  WorkItemSummary,
} from '@/lib/types';
import { lastAutonomyEvent, type AutonomyEventView } from '@/lib/work-items';

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
  const benchmarkGate = await safeGet<BenchmarkGateStatusWire | null>(
    `/factories/${encoded}/benchmark-gate`,
    null,
  );

  // There is no `GET /autonomy` read endpoint yet: the newest `autonomy.*` event in this
  // factory's work-item log is the only durable projection of a kill-switch change.
  const workItems = await safeGet<{ workItems: WorkItemSummary[] }>(
    `/work-items?factory=${encoded}&limit=40`,
    { workItems: [] },
  );
  const itemDetails = await Promise.all(
    workItems.workItems.map((item) =>
      safeGet<WorkItemDetail | null>(`/work-items/${encodeURIComponent(item.id)}`, null),
    ),
  );
  let autonomyEvent: AutonomyEventView | null = null;
  for (const item of itemDetails) {
    if (!item) continue;
    const candidate = lastAutonomyEvent(item.events);
    if (!candidate?.at) continue;
    if (!autonomyEvent?.at || Date.parse(candidate.at) > Date.parse(autonomyEvent.at)) {
      autonomyEvent = candidate;
    }
  }

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
            <span className="font-mono">{gates.mergePolicy}</span>. Enabling this in production
            requires a benchmark non-regression gate
            {gates.benchmarkGateRequired ? ' — and this factory reports it as required' : ''}. The
            gate is satisfied only by a passing, calibrated attestation matching the current
            definition commit + configuration hash (ADR-018).
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

      <Card testId="gates-attestation-card">
        <CardHeader
          title="Benchmark attestation"
          hint="An attestation binds the definition commit + configuration hash; changing either invalidates it."
          action={
            benchmarkGate ? (
              <Badge
                tone={benchmarkGate.satisfied ? 'success' : benchmarkGate.required ? 'warning' : 'neutral'}
                testId="gates-attestation-badge"
              >
                {benchmarkGate.required
                  ? benchmarkGate.satisfied
                    ? 'current'
                    : 'missing'
                  : 'not required'}
              </Badge>
            ) : null
          }
        />
        <CardBody className="space-y-2 text-xs text-slate-700">
          {benchmarkGate ? (
            <>
              <p data-testid="gates-attestation-status" data-satisfied={benchmarkGate.satisfied ? 'true' : 'false'}>
                <span className="font-semibold">
                  {benchmarkGate.required ? 'Required' : 'Not required'}:
                </span>{' '}
                {benchmarkGate.satisfied
                  ? 'a passing, calibrated attestation matches this version.'
                  : benchmarkGate.reason ?? 'no attestation matches this version.'}
              </p>
              <ul className="space-y-1">
                {benchmarkGate.suites.map((entry) => (
                  <li key={entry.suite} data-testid="gates-attestation-suite" className="font-mono text-[11px] text-slate-600">
                    {entry.suite} · {entry.configHash.slice(0, 12)} ·{' '}
                    {entry.attestation
                      ? `${entry.attestation.passed ? 'passed' : 'failed'}${entry.attestation.calibrationOk ? ', calibrated' : ', uncalibrated'}${entry.attestation.partial ? ', partial (not gate-eligible)' : ''} (${Math.round((entry.attestation.passRate ?? 0) * 100)}%)`
                      : 'no attestation'}
                  </li>
                ))}
              </ul>
              <p>
                <a
                  data-testid="gates-attestation-link"
                  href={`/factories/${encoded}/benchmarks`}
                  className="text-slate-900 underline decoration-slate-300 underline-offset-2"
                >
                  Run or inspect the benchmark suite →
                </a>
              </p>
            </>
          ) : (
            <p data-testid="gates-attestation-unavailable" className="text-slate-500">
              Attestation status is unavailable: the benchmark gate projection could not be read.
            </p>
          )}
        </CardBody>
      </Card>

      <Card testId="gates-autonomy-card">
        <CardHeader
          title="Autonomy and kill switch"
          hint="Enabling is guardrailed by a passing benchmark attestation; pausing always works."
        />
        <CardBody>
          {gates ? (
            <AutonomyControl
              factory={factory}
              benchmarkGateRequired={gates.benchmarkGateRequired}
              benchmarkAttestationSatisfied={benchmarkGate?.satisfied ?? false}
              benchmarkAttestationCode={benchmarkGate?.code ?? null}
              fullyAutonomous={gates.fullyAutonomous}
              mergePolicy={gates.mergePolicy}
              initialEvent={autonomyEvent}
            />
          ) : (
            <EmptyState
              testId="gates-autonomy-unavailable"
              title="Autonomy state is unavailable"
              description="The factory manifest could not be loaded from the API, so the autonomy policy cannot be shown or changed."
            />
          )}
        </CardBody>
      </Card>

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
        A gate decision is a durable workflow wait: it holds no activity slot. The kill switch pauses new
        stage dispatch and forces every gate back to <span className="font-mono">human</span>. Enabling
        autonomy on a fully autonomous factory is refused while no passing, calibrated benchmark
        attestation matches the current definition commit + configuration hash, unless an explicit
        override <span className="font-mono">{'{actor, reason}'}</span> is confirmed above.
      </p>
    </div>
  );
}
