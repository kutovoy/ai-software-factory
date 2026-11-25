import { AutonomyControl } from '@/components/factory/AutonomyControl';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { safeGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { GATE_STAGES, docOf, gateMeaning, type AutomationDoc } from '@/lib/definition';
import type {
  AutonomyReadWire,
  BenchmarkGateStatusWire,
  CanaryOverviewWire,
  FactoryDetail,
  FactoryResources,
  GateStage,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

const MERGE_POLICY_NOTES: Record<string, string> = {
  human: 'a human merges every pull request',
  auto_on_green: 'merges automatically once checks are green',
  auto_after_n_approvals: 'merges after the configured number of approvals',
  disabled: 'merging is disabled for this factory',
};

export default async function GatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const factory = decodeURIComponent(id);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    loadFactory(factory),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);
  const factoryName = factoryNameOf(detail, factory);
  const benchmarkGate = await safeGet<BenchmarkGateStatusWire | null>(
    `/factories/${encoded}/benchmark-gate`,
    null,
  );
  const canary = await safeGet<CanaryOverviewWire | null>(`/factories/${encoded}/canary`, null);

  // `GET /autonomy` is the read model (task 1.4): declared policy + enabled/paused +
  // actor/reason/updatedAt + the newest `autonomy.*` event. The page no longer scans
  // work-item events to infer the kill-switch state.
  const autonomy = await safeGet<{ autonomy: AutonomyReadWire } | null>(
    `/factories/${encoded}/autonomy`,
    null,
  );
  const autonomyRead = autonomy?.autonomy ?? null;

  const gates = detail?.gates ?? null;
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
            {factoryHeading(detail?.alias, factoryName, 'Gates')}
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
                {!benchmarkGate.required
                  ? 'human gates remain, so a benchmark attestation is not required to merge. The suite rows below report the current attestation state.'
                  : benchmarkGate.satisfied
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

      <Card testId="gates-canary-card">
        <CardHeader
          title="Canary rollout"
          hint="A canary routes new work items by a deterministic hash; the observation window decides promotion or rollback."
          action={
            canary?.active ? (
              <Badge tone="info" testId="gates-canary-badge">
                active · {canary.active.rollout.canaryPercent}%
              </Badge>
            ) : canary?.history[0]?.rollout.status === 'rolled_back' ? (
              <Badge tone="warning" testId="gates-canary-badge">
                last: rolled back
              </Badge>
            ) : canary?.history[0]?.rollout.status === 'promoted' ? (
              <Badge tone="success" testId="gates-canary-badge">
                last: promoted
              </Badge>
            ) : (
              <Badge tone="neutral" testId="gates-canary-badge">
                none
              </Badge>
            )
          }
        />
        <CardBody className="space-y-2 text-xs text-slate-700">
          <p data-testid="gates-canary-status" data-status={canary?.active?.rollout.status ?? 'none'}>
            <span className="font-semibold">
              {canary?.active ? 'Active:' : 'No active rollout'}:
            </span>{' '}
            {canary?.active
              ? `${canary.active.rollout.candidateVersion} receives ${canary.active.rollout.canaryPercent}% of new work items (${canary.active.split.candidateItems} candidate / ${canary.active.split.stableItems} stable so far); the window closes at ${canary.active.window.endsAt ?? '—'}.`
              : canary?.resolved.authority === 'canary'
                ? `authority is canary (${canary.resolved.canaryPercent ?? 'unset'}% configured); apply an accepted proposal to start a rollout.`
                : `authority is ${canary?.resolved.authority ?? 'unknown'}; canary routing is off.`}
          </p>
          <p>
            <a
              data-testid="gates-canary-link"
              href={`/factories/${encoded}/self-improvement`}
              className="text-slate-900 underline decoration-slate-300 underline-offset-2"
            >
              Open the canary panel →
            </a>
          </p>
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
              factoryId={factory}
              benchmarkGateRequired={autonomyRead?.declared.benchmarkGateRequired ?? gates.benchmarkGateRequired}
              benchmarkAttestationSatisfied={
                autonomyRead?.benchmarkAttestation.satisfied ?? benchmarkGate?.satisfied ?? false
              }
              benchmarkAttestationCode={
                autonomyRead?.benchmarkAttestation.code ?? benchmarkGate?.code ?? null
              }
              fullyAutonomous={autonomyRead?.declared.fullyAutonomous ?? gates.fullyAutonomous}
              mergePolicy={autonomyRead?.declared.mergePolicy ?? gates.mergePolicy}
              initialEvent={autonomyRead?.lastEvent ?? null}
              initialState={autonomyRead}
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

      <Card testId="gates-review-capacity">
        <CardHeader
          title="Review capacity"
          hint="The factory-level attention budget from quality.reviewCapacity: pending gates, unread diff volume and the oldest gate."
          action={
            autonomyRead?.reviewCapacity ? (
              <span
                data-testid="gates-review-capacity-badge"
                data-saturated={autonomyRead.reviewCapacity.saturated ? 'true' : 'false'}
              >
                <Badge
                  tone={autonomyRead.reviewCapacity.saturated ? 'danger' : 'success'}
                  testId="gates-review-capacity-saturation"
                >
                  {autonomyRead.reviewCapacity.saturated ? 'saturated' : 'within capacity'}
                </Badge>
              </span>
            ) : null
          }
        />
        <CardBody className="space-y-2 text-xs text-slate-700">
          {autonomyRead?.reviewCapacity ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Open gates</p>
                  <p data-testid="gates-review-capacity-open-gates" className="font-mono text-sm text-slate-800">
                    {autonomyRead.reviewCapacity.openGates}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Unread diff lines</p>
                  <p
                    data-testid="gates-review-capacity-unread-lines"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.reviewCapacity.unreadDiffLines}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Oldest gate</p>
                  <p
                    data-testid="gates-review-capacity-oldest-gate"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.reviewCapacity.oldestGateHours.toFixed(1)}h
                  </p>
                </div>
              </div>
              {autonomyRead.reviewCapacity.reasons.length > 0 ? (
                <ul data-testid="gates-review-capacity-reasons" className="space-y-0.5 text-red-800">
                  {autonomyRead.reviewCapacity.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : (
                <p data-testid="gates-review-capacity-reasons-empty" className="text-slate-500">
                  No cap is exceeded. Enabling full autonomy stays available without an override.
                </p>
              )}
              <p data-testid="gates-review-capacity-hint" className="text-slate-500">
                When saturated, drain the queue before starting more work: review or reject open gates
                first, and split large changes into smaller ones so each diff fits the budget. Enabling
                full autonomy is refused until the queue is drained unless an explicit override is
                recorded.
              </p>
            </>
          ) : (
            <EmptyState
              testId="gates-review-capacity-unavailable"
              title="Review capacity is unavailable"
              description="The autonomy read model could not be loaded, so no capacity measurement exists. This is not a zero backlog — refresh once the API is reachable."
            />
          )}
        </CardBody>
      </Card>

      <Card testId="gates-comprehension">
        <CardHeader
          title="Comprehension"
          hint="Aggregate proxies over review packets and human gate decisions. They never claim a person read a specific diff."
        />
        <CardBody className="space-y-2 text-xs text-slate-700">
          {autonomyRead?.comprehension ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Unread diff volume</p>
                  <p
                    data-testid="gates-comprehension-unread-lines"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.comprehension.unreadDiffLines}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Without human review</p>
                  <p
                    data-testid="gates-comprehension-items-without-review"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.comprehension.itemsWithoutHumanReview}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Modules without touch</p>
                  <p
                    data-testid="gates-comprehension-modules-without-touch"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.comprehension.modulesWithoutHumanTouch}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-400">Review coverage</p>
                  <p
                    data-testid="gates-comprehension-coverage"
                    className="font-mono text-sm text-slate-800"
                  >
                    {autonomyRead.comprehension.reviewCoveragePercent}%
                  </p>
                </div>
              </div>
              <p data-testid="gates-comprehension-note" className="text-slate-500">
                These are aggregate proxies, not per-person surveillance: review coverage counts work
                items whose newest review packet has a human gate decision, and unread volume counts the
                diff lines of packets that have none.
              </p>
            </>
          ) : (
            <EmptyState
              testId="gates-comprehension-unavailable"
              title="Comprehension metrics are unavailable"
              description="The autonomy read model could not be loaded. Nothing is reported rather than showing fabricated zeroes — refresh once the API is reachable."
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
