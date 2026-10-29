import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { docOf, type ScorerDoc } from '@/lib/definition';
import type { FactoryDetail, FactoryResources } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ScorersPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

  const scorers = (resources?.resources ?? [])
    .filter((resource) => resource.kind === 'scorer')
    .map((resource) => ({ resource, doc: docOf<ScorerDoc>(resource) }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Scorers
          </h1>
          <p className="text-sm text-slate-500">
            LLM-as-judge scorers over real runs: weighted classifications, pass threshold, sample rate and
            the judge model.
          </p>
        </div>
        <Badge tone="neutral" testId="scorers-count">
          {scorers.length} scorers
        </Badge>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="scorers-readonly-banner" />

      <div
        data-testid="scorers-phase-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">Scoring runs in Phase 4.</span> The configuration below is real and
        comes from git; pass rates, counts and sparklines do not exist yet, so none are shown.
      </div>

      {scorers.length === 0 ? (
        <EmptyState
          testId="scorers-empty"
          title="No scorers declared"
          description="The definition has no resources under scorers/, so runs cannot be scored yet."
        />
      ) : (
        <div className="space-y-4">
          {scorers.map(({ resource, doc }) => (
            <Card key={resource.path} testId="scorer-card">
              <CardHeader
                title={doc.description ?? resource.name}
                hint={resource.path}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral" mono testId="scorer-judge-model">
                      {doc.judgeModel ?? '—'}
                    </Badge>
                    {doc.selfImprovement ? (
                      <Badge tone="info" testId="scorer-self-improvement">
                        self-improvement
                      </Badge>
                    ) : null}
                  </div>
                }
              />
              <CardBody className="space-y-3">
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-slate-500">Passing score</dt>
                    <dd data-testid="scorer-passing-score" className="font-mono text-sm text-slate-900">
                      {doc.passingScore ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Sample rate</dt>
                    <dd data-testid="scorer-sampling-rate" className="font-mono text-sm text-slate-900">
                      {doc.samplingRate === undefined ? '—' : `${doc.samplingRate}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Agents</dt>
                    <dd data-testid="scorer-agents" className="font-mono text-xs text-slate-700">
                      {(doc.agents ?? []).join(', ') || '—'}
                    </dd>
                  </div>
                </dl>

                <div>
                  <p className="text-xs font-medium text-slate-600">Classifications</p>
                  <ul data-testid="scorer-labels" className="mt-1 divide-y divide-slate-100">
                    {(doc.labels ?? []).map((label) => (
                      <li
                        key={label.value}
                        data-testid="scorer-label-row"
                        className="grid gap-1 py-1.5 text-xs sm:grid-cols-[5rem,10rem,1fr]"
                      >
                        <span className="font-mono font-medium text-slate-900">{label.score}</span>
                        <span className="font-mono text-slate-700">{label.value}</span>
                        <span className="text-slate-600">{label.description ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="text-[11px] text-slate-400">
                  Scorer name <span className="font-mono">{resource.name}</span> · output{' '}
                  <span className="font-mono">{doc.output ?? 'classification'}</span>
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
