import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ApiClientError, apiGet, safeGet } from '@/lib/api';
import { formatCost, formatDateTime, formatTokens, statusTone } from '@/lib/format';
import type { FactoryListItem, ScoreDetailResponse, ScoreEvidenceWire } from '@/lib/types';

export const dynamic = 'force-dynamic';

function evidenceHref(ref: string, runId: string, factoryId: string): string {
  const base = `/factories/${encodeURIComponent(factoryId)}`;
  if (ref.startsWith('work_item:')) {
    return `${base}/work-items/${encodeURIComponent(ref.slice('work_item:'.length))}`;
  }
  if (ref.startsWith('event:')) {
    return `${base}/runs/${encodeURIComponent(runId)}?focus=${encodeURIComponent(ref.slice('event:'.length))}`;
  }
  return `${base}/runs/${encodeURIComponent(runId)}`;
}

function EvidenceRow({
  evidence,
  runId,
  factoryId,
}: {
  evidence: ScoreEvidenceWire;
  runId: string;
  factoryId: string;
}) {
  return (
    <li data-testid="score-evidence" className="flex flex-wrap items-center gap-2 text-xs">
      <Badge tone="neutral" mono>
        {evidence.kind}
      </Badge>
      <Link
        href={evidenceHref(evidence.ref, runId, factoryId)}
        className="font-mono text-slate-800 underline decoration-slate-300 underline-offset-2"
      >
        {evidence.ref}
      </Link>
      {Object.keys(evidence.detail).length > 0 ? (
        <span className="text-slate-500">{JSON.stringify(evidence.detail)}</span>
      ) : null}
    </li>
  );
}

export default async function ScoreDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let detail: ScoreDetailResponse;
  try {
    detail = await apiGet<ScoreDetailResponse>(`/scores/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) notFound();
    throw error;
  }

  const { score, evidence, events, calibration } = detail;

  // A score belongs to a factory; resolve its id from the viewer's factory list so every
  // link stays inside that factory's id namespace.
  const factories = await safeGet<{ factories: FactoryListItem[] }>('/factories', {
    factories: [],
  });
  const owner = factories.factories.find(
    (entry) => entry.key === score.factory || entry.name === score.factory,
  );
  const factoryId = owner?.id ?? owner?.key ?? null;
  if (!factoryId) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-900">Score · {score.scorer}</h1>
            <Badge tone={statusTone(score.status === 'ok' ? 'ok' : score.status === 'skipped' ? 'blocked' : 'error')} testId="score-status">
              {score.status}
            </Badge>
            <Badge tone={score.scorerClass === 'deterministic' ? 'info' : 'neutral'} testId="score-class">
              {score.scorerClass}
            </Badge>
            {score.uncalibrated ? (
              <Badge tone="warning" testId="score-uncalibrated">
                uncalibrated
              </Badge>
            ) : null}
          </div>
          <p className="font-mono text-xs text-slate-500" data-testid="score-id">
            {score.id}
          </p>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p>
            Run{' '}
            <Link
              href={`/factories/${encodeURIComponent(factoryId)}/runs/${encodeURIComponent(score.runId)}`}
              className="font-mono text-slate-800 underline decoration-slate-300 underline-offset-2"
              data-testid="score-run-link"
            >
              {score.runId}
            </Link>
          </p>
          {score.workItemId ? (
            <p>
              Work item{' '}
              <Link
                href={`/factories/${encodeURIComponent(factoryId)}/work-items/${encodeURIComponent(score.workItemId)}`}
                className="font-mono text-slate-800 underline decoration-slate-300 underline-offset-2"
              >
                {score.workItemId}
              </Link>
            </p>
          ) : null}
          {score.stage ? <p>Stage {score.stage}</p> : null}
          <p>{formatDateTime(score.createdAt)}</p>
        </div>
      </header>

      <Card testId="score-outcome">
        <CardHeader
          title="Outcome"
          hint="A score is a classification plus a score plus evidence. Errors are first-class, never a guessed pass."
        />
        <CardBody className="space-y-4">
          {score.status === 'ok' ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Label</dt>
                <dd data-testid="score-label" className="font-mono text-slate-900">
                  {score.label ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Score</dt>
                <dd data-testid="score-value" className="font-mono text-slate-900">
                  {score.score ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Passing</dt>
                <dd data-testid="score-passing">
                  <Badge tone={score.passing ? 'success' : 'danger'}>{score.passing ? 'pass' : 'fail'}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Cost</dt>
                <dd data-testid="score-cost" className="font-mono text-slate-900">
                  {formatCost(score.provenance.costUsd)}
                </dd>
              </div>
            </dl>
          ) : (
            <div data-testid="score-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <p className="font-semibold">{score.errorCode ?? 'error'}</p>
              <p>{score.rationale ?? 'the scorer did not produce a label'}</p>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Rationale</p>
            <p data-testid="score-rationale" className="mt-1 text-sm text-slate-700">
              {score.rationale ?? '—'}
            </p>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="score-evidence-card">
          <CardHeader title="Evidence" hint="References point at run events/artifacts, never at blobs." />
          {evidence.length === 0 ? (
            <CardBody>
              <EmptyState testId="score-evidence-empty" title="No evidence recorded" />
            </CardBody>
          ) : (
            <CardBody>
              <ul className="space-y-2">
                {evidence.map((item) => (
                  <EvidenceRow
                    key={`${item.kind}-${item.ref}`}
                    evidence={item}
                    runId={score.runId}
                    factoryId={factoryId}
                  />
                ))}
              </ul>
            </CardBody>
          )}
        </Card>

        <Card testId="score-provenance">
          <CardHeader title="Provenance" hint="Judge model + version + rubric hash + prompt hash, so a score can be re-derived." />
          <CardBody className="space-y-2 text-sm">
            <dl className="grid grid-cols-2 gap-2">
              <div>
                <dt className="text-xs text-slate-500">Judge model</dt>
                <dd className="font-mono text-slate-800" data-testid="score-judge-model">
                  {score.provenance.judgeModel ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Model version</dt>
                <dd className="font-mono text-slate-800">
                  {score.provenance.judgeModelVersion ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Rubric hash</dt>
                <dd className="font-mono text-xs text-slate-800">
                  {score.rubricHash.slice(0, 16)}…
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Prompt hash</dt>
                <dd className="font-mono text-xs text-slate-800">
                  {score.provenance.promptHash ? `${score.provenance.promptHash.slice(0, 16)}…` : '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Tokens</dt>
                <dd className="font-mono text-slate-800">
                  in {formatTokens(score.provenance.inputTokens)} · out{' '}
                  {formatTokens(score.provenance.outputTokens)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Cost</dt>
                <dd className="font-mono text-slate-800">{formatCost(score.provenance.costUsd)}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card testId="score-calibration">
          <CardHeader title="Calibration" hint="A passing calibration for this rubric hash + judge model makes the score benchmark-eligible." />
          <CardBody className="space-y-2 text-sm">
            {score.scorerClass === 'deterministic' ? (
              <p className="text-sm text-slate-600">
                Deterministic scorers are model-free and read run artifacts directly; calibration is
                not required.
              </p>
            ) : calibration ? (
              <>
                <p className="flex items-center gap-2">
                  <Badge tone={calibration.verdict === 'pass' ? 'success' : calibration.verdict === 'insufficient_data' ? 'info' : 'danger'}>
                    {calibration.verdict}
                  </Badge>
                  <span className="text-xs text-slate-500">
                    {calibration.sampleSize} sample(s), threshold {calibration.threshold}
                  </span>
                </p>
                <p className="text-xs text-slate-600">
                  Exact agreement{' '}
                  <span className="font-mono">{calibration.agreementExact ?? '—'}</span> · within tolerance{' '}
                  <span className="font-mono">{calibration.agreementWithinTolerance ?? '—'}</span>
                </p>
              </>
            ) : (
              <p data-testid="score-calibration-none" className="text-sm text-slate-600">
                No calibration result for this rubric hash and judge model. The score is flagged{' '}
                <span className="font-mono">uncalibrated</span>.
              </p>
            )}
          </CardBody>
        </Card>

        <Card testId="score-events">
          <CardHeader title="Score events" hint="Append-only, deduped by (score_id, type)." />
          {events.length === 0 ? (
            <CardBody>
              <EmptyState testId="score-events-empty" title="No score event recorded" />
            </CardBody>
          ) : (
            <CardBody>
              <ul className="space-y-1 text-sm">
                {events.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-slate-800">{event.type}</span>
                    <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>
      </div>
    </div>
  );
}
