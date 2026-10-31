import { AuthoritySelector } from '@/components/improvement/AuthoritySelector';
import { CanaryPanel } from '@/components/improvement/CanaryPanel';
import { ImprovementRunButton } from '@/components/improvement/ImprovementRunButton';
import { LessonList } from '@/components/improvement/LessonList';
import { ProposalCard } from '@/components/improvement/ProposalCard';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { ELIGIBILITY_REASONS, authorityTone, proposalStatusLabel } from '@/lib/improvement';
import type {
  CanaryOverviewWire,
  ImprovementOverviewWire,
  LessonWire,
  ProposalWire,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

export default async function SelfImprovementPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [overview, proposalsResponse, lessonsResponse, canary] = await Promise.all([
    safeGet<ImprovementOverviewWire | null>(`/factories/${encoded}/improvement`, null),
    safeGet<{ proposals: ProposalWire[] }>(`/proposals?factory=${encoded}&limit=20`, { proposals: [] }),
    safeGet<{ lessons: LessonWire[]; factory: string; includeShared: boolean }>(
      `/lessons?factory=${encoded}&includeShared=true&limit=100`,
      { lessons: [], factory, includeShared: true },
    ),
    safeGet<CanaryOverviewWire | null>(`/factories/${encoded}/canary`, null),
  ]);

  const resolved = overview?.resolved ?? null;
  const eligibility = overview?.eligibility ?? null;
  const proposals = proposalsResponse.proposals;
  const lessons = lessonsResponse.lessons;
  const lastRun = overview?.lastRun ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(overview?.alias, factory, 'Self-improvement')}
          </h1>
          <p className="text-sm text-slate-500">
            Observer agents read the scored corpus, propose file-scoped edits, probe them against the
            same work, compose the winners, and land the candidate according to the factory&apos;s
            authority.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {resolved ? (
            <Badge tone={authorityTone(resolved.authority)} testId="improvement-authority-badge">
              authority: {resolved.authority}
            </Badge>
          ) : null}
          {eligibility ? (
            <Badge
              tone={eligibility.eligible ? 'success' : 'warning'}
              testId="improvement-eligibility-badge"
            >
              {eligibility.eligible ? 'eligible' : 'ineligible'}
            </Badge>
          ) : null}
          <ImprovementRunButton factory={factory} />
        </div>
      </header>

      <div
        data-testid="improvement-readonly-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600"
      >
        <span className="font-semibold text-slate-800">Definitions stay in git.</span> The authority is a
        definition field, so changing it computes a diff and opens a pull request with actor + reason; the
        console never writes the worktree. Applying a proposal routes by the authority recorded when the
        proposal was created.
      </div>

      {!overview ? (
        <EmptyState
          testId="improvement-unavailable"
          title="Self-improvement projection unavailable"
          description="The API could not project this factory's improvement state. Check the definition and the API."
        />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card testId="self-improvement-settings">
          <CardHeader
            title="Authority"
            hint="factory.yaml › improvement.authority — changing it is a definition change (PR)"
          />
          <CardBody className="space-y-3">
            {resolved ? (
              <>
                <AuthoritySelector factory={factory} resolved={resolved} />
                <div data-testid="improvement-canary-note" className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  <p className="font-semibold">
                    {resolved.authority === 'canary'
                      ? 'Canary authority is enabled.'
                      : 'Canary authority is not enabled.'}
                  </p>
                  <p className="mt-1">
                    {resolved.authority === 'canary'
                      ? `Configured: ${resolved.canaryPercent ?? 'unset'}% of new work, rollback above ${resolved.rollbackThreshold ?? 'unset'}, ${resolved.observationWindowHours}h window. Applying an accepted proposal publishes a candidate version and routes new work by a deterministic hash of the work-item id. Whether a rollout is actually running is reported separately in the canary panel below.`
                      : 'A canary rollout requires authority "canary": the candidate version is published, a configured percentage of new work runs it, and the observation window promotes or rolls it back.'}
                  </p>
                </div>
              </>
            ) : (
              <EmptyState
                testId="self-improvement-settings-empty"
                title="No improvement configuration"
                description="factory.yaml does not declare an improvement block; the resolved authority defaults to propose_only."
              />
            )}
          </CardBody>
        </Card>

        <Card testId="improvement-eligibility">
          <CardHeader
            title="Eligibility"
            hint="Enough scored runs + calibrated judges, both derived from the read model."
          />
          <CardBody className="space-y-2 text-xs text-slate-700">
            {eligibility ? (
              <>
                <p data-testid="improvement-eligibility-status">
                  <span className="font-semibold">
                    {eligibility.eligible ? 'Eligible' : 'Not eligible'}:
                  </span>{' '}
                  {eligibility.scoredRuns} scored run(s) in the window (minimum{' '}
                  {eligibility.minScoredRuns}).
                </p>
                <p data-testid="improvement-eligibility-judges">
                  <span className="font-semibold">Judges:</span>{' '}
                  {eligibility.calibratedJudges.length === 0
                    ? 'none calibrated'
                    : `${eligibility.calibratedJudges.join(', ')} calibrated`}
                  {eligibility.uncalibratedJudges.length > 0
                    ? `; ${eligibility.uncalibratedJudges.join(', ')} uncalibrated`
                    : ''}
                </p>
                {eligibility.reasons.length > 0 ? (
                  <ul data-testid="improvement-eligibility-reasons" className="list-disc space-y-0.5 pl-4 text-amber-800">
                    {eligibility.reasons.map((reason) => (
                      <li key={reason} className="font-mono text-[11px]">
                        {reason} — {ELIGIBILITY_REASONS[reason] ?? 'blocked'}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-500">
                    The observer may propose; probes still decide whether anything is composed.
                  </p>
                )}
              </>
            ) : (
              <p data-testid="improvement-eligibility-empty" className="text-slate-500">
                Eligibility is unavailable because the factory projection could not be read.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card testId="improvement-last-run">
        <CardHeader
          title="Last improvement run"
          hint="improvement.started → proposal.created → probe.completed → candidate.published"
        />
        <CardBody className="text-xs text-slate-700">
          {lastRun ? (
            <dl data-testid="improvement-last-run-detail" className="grid gap-x-6 gap-y-1 md:grid-cols-2">
              <div>
                <dt className="inline font-semibold">Run: </dt>
                <dd className="inline font-mono">{lastRun.id}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Status: </dt>
                <dd className="inline">
                  <Badge tone={lastRun.status === 'completed' ? 'success' : lastRun.status === 'error' ? 'danger' : 'neutral'}>
                    {lastRun.status}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Decision: </dt>
                <dd className="inline font-mono">{lastRun.decision ?? 'pending'}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Proposals / lessons: </dt>
                <dd className="inline font-mono">
                  {lastRun.proposals} / {lastRun.lessons}
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Trigger: </dt>
                <dd className="inline font-mono">{lastRun.trigger}</dd>
              </div>
              <div>
                <dt className="inline font-semibold">Started: </dt>
                <dd className="inline font-mono">{lastRun.startedAt ?? '—'}</dd>
              </div>
              {lastRun.error ? (
                <div className="md:col-span-2 text-red-700">
                  <dt className="inline font-semibold">Error: </dt>
                  <dd className="inline font-mono">{lastRun.error}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p data-testid="improvement-last-run-empty" className="text-slate-500">
              No improvement run yet. Starting one observes the scored corpus; with no scored failures
              (or an ineligible corpus) it completes without inventing a proposal.
            </p>
          )}
        </CardBody>
      </Card>

      <Card testId="canary-card">
        <CardHeader
          title="Canary rollout"
          hint="Candidate vs stable, deterministic-hash traffic split, observation window, score comparison, promote/rollback."
          action={
            canary?.active ? (
              <Badge tone="info" testId="canary-card-badge">
                {canary.active.rollout.canaryPercent}% candidate
              </Badge>
            ) : null
          }
        />
        <CardBody>
          <CanaryPanel factory={factory} overview={canary} />
        </CardBody>
      </Card>

      <Card testId="improvement-proposals">
        <CardHeader
          title="Ranked proposals"
          hint="Clustered by files + failure signature, ranked by impact (failed runs × cost)."
          action={
            <Badge tone="neutral" testId="improvement-proposal-count">
              {proposals.length} proposal{proposals.length === 1 ? '' : 's'}
            </Badge>
          }
        />
        <CardBody className="space-y-3">
          {proposals.length === 0 ? (
            <EmptyState
              testId="improvement-proposals-empty"
              title="No proposals"
              description="Nothing has been observed yet, or the observer found no failure signal. Run an improvement pass to produce one from real scored runs."
            />
          ) : (
            proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)
          )}
          {proposals.length > 0 ? (
            <p className="text-[11px] text-slate-500">
              {proposals
                .map((proposal) => `${proposal.id}: ${proposalStatusLabel(proposal.status)}`)
                .join(' · ')}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card testId="improvement-lessons-card">
        <CardHeader
          title="Experience library"
          hint="INDEX.md + EXPERIENCE.md per factory; promotion to the shared library is opt-in."
        />
        <CardBody>
          <LessonList factory={factory} lessons={lessons} />
        </CardBody>
      </Card>
    </div>
  );
}
