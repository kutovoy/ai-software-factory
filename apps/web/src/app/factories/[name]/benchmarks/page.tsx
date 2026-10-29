import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import {
  docOf,
  type BenchmarkConfigurationDoc,
  type BenchmarkDoc,
  type BenchmarkTaskDoc,
} from '@/lib/definition';
import type { FactoryDetail, FactoryResources } from '@/lib/types';

export const dynamic = 'force-dynamic';

function describeConfiguration(configuration: BenchmarkConfigurationDoc): string {
  const agents = configuration.agents ?? [];
  if (agents.length === 0) return 'factory defaults';
  return agents
    .map((agent) => {
      const model = agent.model ?? agent.harness?.model ?? 'default model';
      const harness = agent.harness?.type ?? 'inherited harness';
      return `${agent.agent ?? 'agent'} · ${harness} · ${model}`;
    })
    .join(', ');
}

export default async function BenchmarksPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

  const all = resources?.resources ?? [];
  const suites = all.filter((resource) => resource.kind === 'benchmark');
  const tasksBySlug = new Map(
    all
      .filter((resource) => resource.kind === 'benchmark-task')
      .map((resource) => [resource.name, docOf<BenchmarkTaskDoc>(resource)]),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Benchmarks
          </h1>
          <p className="text-sm text-slate-500">
            Task sets pinned to a starting repo ref and a definition commit, replayed hermetically and
            compared across factory versions.
          </p>
        </div>
        <Badge tone="neutral" testId="benchmarks-count">
          {suites.length} suites
        </Badge>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="benchmarks-readonly-banner" />

      <div
        data-testid="benchmarks-phase-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">Benchmark runs ship in Phase 4.</span> Suites, configurations and
        tasks below are read from git. No replay has been executed, so there is no correctness-vs-cost matrix
        to show — and none is invented.
      </div>

      {suites.length === 0 ? (
        <EmptyState
          testId="benchmarks-empty"
          title="No benchmark suites declared"
          description="The definition has no resources under benchmarks/."
        />
      ) : (
        <div className="space-y-4">
          {suites.map((resource) => {
            const doc = docOf<BenchmarkDoc>(resource);
            const tasks = doc.tasks ?? [];
            return (
              <div key={resource.path} data-testid="benchmark-suite" data-suite={resource.name}>
                <Card>
                  <CardHeader
                    title={doc.name ?? resource.name}
                    hint={doc.description ?? resource.path}
                    action={
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="info" testId="benchmark-agent">
                          {doc.agent ?? '—'}
                        </Badge>
                        <Badge tone="neutral">{tasks.length} tasks</Badge>
                        <Badge tone="neutral">{(doc.configurations ?? []).length} configurations</Badge>
                      </div>
                    }
                  />
                  <CardBody className="space-y-4">
                    <section>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Configurations
                      </h3>
                      <ul data-testid="benchmark-configurations" className="mt-1 divide-y divide-slate-100">
                        {(doc.configurations ?? []).map((configuration) => (
                          <li
                            key={configuration.name}
                            data-testid="benchmark-configuration-row"
                            className="grid gap-1 py-1.5 text-xs sm:grid-cols-[10rem,1fr]"
                          >
                            <span className="font-mono font-medium text-slate-900">
                              {configuration.name ?? '—'}
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
                        {tasks.map((slug) => {
                          const task = tasksBySlug.get(`${resource.name}/${slug}`);
                          return (
                            <li
                              key={slug}
                              data-testid="benchmark-task-row"
                              data-task={slug}
                              className="rounded-lg border border-slate-200 px-3 py-2 text-xs"
                            >
                              <p className="font-medium text-slate-900">
                                {task?.title ?? slug}{' '}
                                <span className="font-mono text-[11px] text-slate-400">{slug}</span>
                              </p>
                              {task?.successCriteria ? (
                                <p className="mt-0.5 text-slate-600">{task.successCriteria}</p>
                              ) : (
                                <p className="mt-0.5 text-slate-500">
                                  Task definition missing at benchmarks/{resource.name}/tasks/{slug}.yaml.
                                </p>
                              )}
                              {task?.startingRepoRefs?.length ? (
                                <p className="mt-1 font-mono text-[11px] text-slate-500">
                                  {task.startingRepoRefs.join(', ')}
                                </p>
                              ) : null}
                              {task?.tags?.length ? (
                                <p className="mt-1 flex flex-wrap gap-1">
                                  {task.tags.map((tag) => (
                                    <Badge key={tag} tone="neutral">
                                      {tag}
                                    </Badge>
                                  ))}
                                </p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  </CardBody>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
