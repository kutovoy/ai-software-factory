import { BenchmarkResults } from '@/components/benchmarks/BenchmarkResults';
import { BenchmarkRunDialog } from '@/components/benchmarks/BenchmarkRunDialog';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import type {
  BenchmarkRunDetailResponse,
  BenchmarkSuiteListResponse,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

function describeConfiguration(configuration: {
  name: string;
  agents: { agent: string; model?: string; harness?: string }[];
}): string {
  if (configuration.agents.length === 0) return 'factory defaults';
  return configuration.agents
    .map(
      (agent) =>
        `${agent.agent} · ${agent.harness ?? 'inherited harness'} · ${agent.model ?? 'default model'}`,
    )
    .join(', ');
}

export default async function BenchmarksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const factory = decodeURIComponent(id);
  const encoded = encodeURIComponent(factory);

  const [factoryDetail, response] = await Promise.all([
    loadFactory(factory),
    safeGet<BenchmarkSuiteListResponse | null>(`/factories/${encoded}/benchmarks`, null),
  ]);
  const factoryName = factoryNameOf(factoryDetail, factory);
  const latestId = response?.latestRun?.id ?? null;
  const detail = latestId
    ? await safeGet<BenchmarkRunDetailResponse | null>(
        `/factories/${encoded}/benchmarks/${encodeURIComponent(latestId)}`,
        null,
      )
    : null;

  const gate = response?.benchmarkGate ?? null;
  const suites = response?.suites ?? [];
  const attestation = gate?.suites.find((entry) => entry.attestation)?.attestation ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(response?.alias, factoryName, 'Benchmarks')}
          </h1>
          <p className="text-sm text-slate-500">
            Task sets pinned to full repo SHAs and a definition commit, replayed hermetically on the
            fake harness + forge, then compared as a pass-rate-versus-cost frontier.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" testId="benchmarks-count">
            {suites.length} suites
          </Badge>
          {gate ? (
            <Badge
              tone={gate.satisfied ? 'success' : gate.required ? 'warning' : 'neutral'}
              testId="benchmarks-gate-badge"
            >
              {gate.required
                ? gate.satisfied
                  ? 'attestation current'
                  : 'attestation missing'
                : 'benchmark gate not required'}
            </Badge>
          ) : null}
          {attestation ? (
            <Badge tone={attestation.partial ? 'warning' : 'success'} testId="benchmark-attestation-badge">
              {attestation.partial ? 'partial attestation' : 'attested'} {attestation.suite} ·{' '}
              {Math.round((attestation.passRate ?? 0) * 100)}%
            </Badge>
          ) : (
            <Badge tone="neutral" testId="benchmark-attestation-empty">
              no attestation
            </Badge>
          )}
        </div>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="benchmarks-readonly-banner" />

      {response ? (
        <div
          data-testid="benchmarks-version"
          className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600"
        >
          Definition <span className="font-mono">{response.definitionCommit.slice(0, 8)}</span>
          {response.definitionDirty ? ' (dirty worktree)' : ''} · latest run:{' '}
          <span className="font-mono">{response.latestRun?.id ?? 'none'}</span>
          {gate?.reason ? <span className="ml-2 text-amber-800">{gate.reason}</span> : null}
        </div>
      ) : (
        <EmptyState
          testId="benchmarks-unavailable"
          title="Benchmark suites are unavailable"
          description="The API could not project this factory's benchmark suites. Check the definition and the API."
        />
      )}

      {suites.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            Suites and tasks are read from git. Every trial is a child run at the pinned commit; a
            partial selection reports results but cannot attest.
          </p>
          <BenchmarkRunDialog
            factoryId={factory}
            suites={suites}
            defaultMaxCostUsd={detail?.benchmark.maxCostUsd ?? 25}
          />
        </div>
      ) : null}

      {suites.length === 0 ? (
        <EmptyState
          testId="benchmarks-empty"
          title="No benchmark suites declared"
          description="The definition has no resources under benchmarks/."
        />
      ) : (
        <div className="space-y-4">
          {suites.map((suite) => (
            <div key={suite.path} data-testid="benchmark-suite" data-suite={suite.name}>
              <Card>
                <CardHeader
                  title={suite.name}
                  hint={suite.description ?? suite.path}
                  action={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="info" testId="benchmark-agent">
                        {suite.agent}
                      </Badge>
                      <Badge tone="neutral">{suite.tasks.length} tasks</Badge>
                      <Badge tone="neutral">{suite.configurations.length} configurations</Badge>
                      <Badge tone="neutral">{suite.trialCount} trials</Badge>
                      <Badge
                        tone={suite.attestation?.passed ? (suite.attestation.partial ? 'warning' : 'success') : 'neutral'}
                        testId="benchmark-suite-attestation"
                      >
                        {suite.attestation?.passed
                          ? suite.attestation.partial
                            ? 'partial attestation'
                            : 'attested'
                          : 'not attested'}
                      </Badge>
                    </div>
                  }
                />
                <CardBody className="space-y-4">
                  <p className="font-mono text-[11px] text-slate-500" data-testid="benchmark-config-hash">
                    configHash {suite.configHash}
                  </p>
                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Configurations
                    </h3>
                    <ul data-testid="benchmark-configurations" className="mt-1 divide-y divide-slate-100">
                      {suite.configurations.map((configuration) => (
                        <li
                          key={configuration.name}
                          data-testid="benchmark-configuration-row"
                          className="grid gap-1 py-1.5 text-xs sm:grid-cols-[10rem,1fr]"
                        >
                          <span className="font-mono font-medium text-slate-900">
                            {configuration.name}
                          </span>
                          <span className="font-mono text-slate-600">
                            {describeConfiguration(configuration)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks</h3>
                    <ul data-testid="benchmark-tasks" className="mt-1 space-y-2">
                      {suite.tasks.map((task) => (
                        <li
                          key={task.slug}
                          data-testid="benchmark-task-row"
                          data-task={task.slug}
                          className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                        >
                          <p className="font-medium text-slate-900">
                            {task.title}{' '}
                            <span className="font-mono text-[11px] text-slate-400">{task.slug}</span>
                          </p>
                          <p className="mt-0.5 text-slate-600">{task.successCriteria}</p>
                          <p className="mt-1 font-mono text-[11px] text-slate-500">
                            {task.startingRepoRefs.join(', ')}
                          </p>
                          {task.tags.length > 0 ? (
                            <p className="mt-1 flex flex-wrap gap-1">
                              {task.tags.map((tag) => (
                                <Badge key={tag} tone="neutral">
                                  {tag}
                                </Badge>
                              ))}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                </CardBody>
              </Card>
            </div>
          ))}
        </div>
      )}

      {detail ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Latest run</h2>
          <BenchmarkResults factoryId={factory} detail={detail} />
        </section>
      ) : response?.latestRun ? (
        <EmptyState
          testId="benchmark-latest-unavailable"
          title="Latest run could not be loaded"
          description={`Run ${response.latestRun.id} exists, but its detail projection is unavailable.`}
        />
      ) : null}

      {gate?.required && !gate.satisfied ? (
        <div
          data-testid="benchmarks-attestation-note"
          role="note"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"
        >
          This factory is fully autonomous, so enabling autonomy needs a passing, calibrated
          attestation for the current definition commit + configuration hash. Run the full suite to
          produce one; a partial run reports results but cannot attest.
        </div>
      ) : null}
    </div>
  );
}
