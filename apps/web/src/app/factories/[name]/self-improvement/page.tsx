import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { docOf, type ScorerDoc } from '@/lib/definition';
import type { FactoryDetail, FactoryResources } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function SelfImprovementPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

  const settings = detail?.factory.manifest.selfImprovement ?? null;
  const scorers = (resources?.resources ?? [])
    .filter((resource) => resource.kind === 'scorer')
    .map((resource) => ({ resource, doc: docOf<ScorerDoc>(resource) }))
    .filter((entry) => entry.doc.selfImprovement === true);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Self-improvement
          </h1>
          <p className="text-sm text-slate-500">
            Observer agents read scored runs, propose definition edits, and gate them behind a benchmark
            non-regression win.
          </p>
        </div>
        {settings ? (
          <Badge tone={settings.enabled ? 'success' : 'neutral'} testId="self-improvement-enabled">
            {settings.enabled ? 'enabled' : 'disabled'}
          </Badge>
        ) : null}
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="self-improvement-readonly-banner" />

      <div
        data-testid="self-improvement-phase-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">The observer loop ships in Phase 5.</span> The settings and the
        scorers that feed it are real and come from git. No proposal has been produced yet, so the inbox
        below is empty rather than populated with examples.
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card testId="self-improvement-settings">
          <CardHeader title="Settings" hint="factory.yaml › selfImprovement" />
          <CardBody>
            {settings ? (
              <dl className="grid grid-cols-[11rem,1fr] gap-y-2 text-sm">
                <dt className="text-slate-500">Enabled</dt>
                <dd>
                  <Badge tone={settings.enabled ? 'success' : 'neutral'}>
                    {settings.enabled ? 'yes' : 'no'}
                  </Badge>
                </dd>
                <dt className="text-slate-500">Failed-run threshold</dt>
                <dd data-testid="self-improvement-threshold" className="font-mono text-xs text-slate-800">
                  {settings.failedRunThreshold} failed runs before a proposal
                </dd>
                <dt className="text-slate-500">Reviewer type</dt>
                <dd data-testid="self-improvement-reviewer">
                  <Badge tone={settings.reviewerType === 'none' ? 'warning' : 'info'} mono>
                    {settings.reviewerType}
                  </Badge>
                  <span className="ml-2 text-xs text-slate-500">
                    {settings.reviewerType === 'none'
                      ? 'lights off — proposals are judged by the benchmark gate alone'
                      : 'a human reviews every proposal before merge'}
                  </span>
                </dd>
                <dt className="text-slate-500">Benchmark win</dt>
                <dd data-testid="self-improvement-benchmark-win">
                  <Badge tone={settings.requireBenchmarkWin ? 'success' : 'warning'}>
                    {settings.requireBenchmarkWin ? 'required' : 'not required'}
                  </Badge>
                </dd>
              </dl>
            ) : (
              <EmptyState
                testId="self-improvement-settings-empty"
                title="No self-improvement block"
                description="factory.yaml does not declare a selfImprovement section, so the loop is off."
              />
            )}
          </CardBody>
        </Card>

        <Card testId="self-improvement-scorers">
          <CardHeader title="Scorers feeding the loop" hint="scorer.md › selfImprovement: true" />
          <CardBody>
            {scorers.length === 0 ? (
              <EmptyState
                testId="self-improvement-scorers-empty"
                title="No scorer opts in"
                description="No scorer declares selfImprovement: true, so failing runs cannot be clustered into proposals."
              />
            ) : (
              <ul className="space-y-2 text-sm">
                {scorers.map(({ resource, doc }) => (
                  <li
                    key={resource.path}
                    data-testid="self-improvement-scorer-row"
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="font-mono text-xs font-medium text-slate-900">{resource.name}</span>
                    <span className="text-xs text-slate-500">{doc.description ?? resource.summary}</span>
                    <Badge tone="neutral" mono>
                      pass {doc.passingScore ?? '—'}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      <Card testId="self-improvement-proposals">
        <CardHeader
          title="Proposals"
          hint="Clustered by root cause and ranked by impact (failed runs × cost)."
        />
        <CardBody>
          <EmptyState
            testId="self-improvement-proposals-empty"
            title="No proposals yet"
            description="Nothing has been scored and no observer run has executed. This inbox fills in Phase 5."
          />
        </CardBody>
      </Card>
    </div>
  );
}
