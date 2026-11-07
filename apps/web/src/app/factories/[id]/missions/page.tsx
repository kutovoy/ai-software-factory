import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { TimeAgo } from '@/components/ui/TimeAgo';
import { CreateMissionForm } from '@/components/missions/CreateMissionForm';
import { getOrError } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { formatCost, shortCommit } from '@/lib/format';
import {
  MISSION_STATUSES,
  missionProgress,
  missionStatusTone,
  shortMissionId,
} from '@/lib/missions';
import type { MissionListResponseWire, MissionSummary } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Mission Control list: `/factories/:id/missions` (change `add-long-running-missions`). */
export default async function MissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id } = await params;
  const { status } = await searchParams;
  const factoryId = decodeURIComponent(id);
  const encoded = encodeURIComponent(factoryId);
  const basePath = `/factories/${encoded}/missions`;

  const [factory, list] = await Promise.all([
    loadFactory(factoryId),
    getOrError<MissionListResponseWire>(`/factories/${encoded}/missions`),
  ]);
  const factoryName = factoryNameOf(factory, factoryId);

  const missions = list.data?.missions ?? [];
  const counts = new Map<string, number>();
  for (const mission of missions) {
    counts.set(mission.status, (counts.get(mission.status) ?? 0) + 1);
  }

  // The API returns the owner-scoped list; the chip selection narrows it locally so an
  // unknown/absent status never hides the whole page behind a dead filter.
  const selected = status && MISSION_STATUSES.includes(status as MissionSummary['status'])
    ? status
    : null;
  const visible = selected ? missions.filter((mission) => mission.status === selected) : missions;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">{factoryName} › Missions</h1>
          <p className="text-sm text-slate-500">
            A mission is a durable goal above work items: a planner proposes a validation
            contract, milestones and features, a human approves the plan, and fresh workers run
            one feature at a time. Progress, spend and the current milestone are projections of
            recorded mission rows — nothing is inferred here.
          </p>
        </div>
        <Badge tone="neutral" testId="missions-count">
          {visible.length} of {missions.length} mission{missions.length === 1 ? '' : 's'}
        </Badge>
      </header>

      <Card testId="missions-create-card">
        <CardHeader
          title="New mission"
          hint="The mission is persisted, then planned; approve its plan before any feature is dispatched."
        />
        <CardBody>
          <CreateMissionForm factoryId={factoryId} />
        </CardBody>
      </Card>

      <nav
        data-testid="missions-status-filters"
        aria-label="Mission status filters"
        className="flex flex-wrap items-center gap-1"
      >
        <Link
          href={basePath}
          data-testid="missions-status-all"
          data-active={selected === null ? 'true' : 'false'}
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            selected === null ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          all {missions.length}
        </Link>
        {MISSION_STATUSES.map((entry) => {
          const active = selected === entry;
          return (
            <Link
              key={entry}
              href={`${basePath}?status=${encodeURIComponent(entry)}`}
              data-testid={`missions-status-${entry}`}
              data-active={active ? 'true' : 'false'}
              aria-pressed={active}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                active ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {entry.replace(/_/g, ' ')} {counts.get(entry) ?? 0}
            </Link>
          );
        })}
      </nav>

      {list.error ? (
        <EmptyState
          testId="missions-unavailable"
          title="Missions are unavailable"
          description={`The API could not be read (${list.error.code}). The list is a projection — it never invents missions.`}
        />
      ) : missions.length === 0 ? (
        <EmptyState
          testId="missions-empty"
          title="No missions yet"
          description="Create one above with a goal; the planner writes the validation contract and the milestone/feature plan, then waits for your approval."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          testId="missions-filter-empty"
          title="No missions match this status"
          description={`${missions.length} mission(s) exist for ${factoryName}, but none is ${selected}. Widen the filter.`}
          action={
            <Link
              href={basePath}
              data-testid="missions-filter-reset"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Show all missions
            </Link>
          }
        />
      ) : (
        <Card testId="missions-list">
          <Table
            testId="missions-table"
            rowTestId="mission-row"
            rows={visible}
            rowKey={(mission) => mission.id}
            columns={[
              {
                header: 'Mission',
                cell: (mission) => {
                  const progress = missionProgress(mission);
                  return (
                    <div className="space-y-1">
                      <Link
                        href={`${basePath}/${encodeURIComponent(mission.id)}`}
                        data-testid="mission-row-link"
                        className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
                      >
                        {mission.title}
                      </Link>
                      <p className="font-mono text-[11px] text-slate-400" data-testid="mission-row-id">
                        {mission.id}
                      </p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {mission.factory}@{shortCommit(mission.definitionCommit)}
                      </p>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-200">
                          <div
                            data-testid="mission-row-progress-bar"
                            data-percent={progress.percent}
                            className="h-full rounded-full bg-sky-600"
                            style={{ width: `${progress.percent}%` }}
                          />
                        </div>
                        <span
                          data-testid="mission-row-progress"
                          className="font-mono text-[11px] text-slate-600"
                        >
                          {progress.label} features
                        </span>
                        {progress.failed > 0 ? (
                          <span
                            data-testid="mission-row-failed"
                            className="font-mono text-[11px] text-red-700"
                          >
                            {progress.failed} failed
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                },
              },
              {
                header: 'Status',
                cell: (mission) => (
                  <div className="space-y-1">
                    <span data-testid="mission-row-status" data-status={mission.status}>
                      <Badge tone={missionStatusTone(mission.status)}>
                        {mission.status.replace(/_/g, ' ')}
                      </Badge>
                    </span>
                    {mission.error ? (
                      <p data-testid="mission-row-error" className="max-w-[16rem] text-[11px] text-red-700">
                        {mission.error}
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                header: 'Current milestone',
                cell: (mission) => (
                  <span
                    data-testid="mission-row-milestone"
                    className="font-mono text-[11px] text-slate-600"
                  >
                    {shortMissionId(mission.currentMilestoneId)}
                  </span>
                ),
              },
              {
                header: 'Milestones',
                cell: (mission) => (
                  <span data-testid="mission-row-milestones" className="font-mono text-xs text-slate-600">
                    {mission.milestoneDone ?? 0}/{mission.milestoneTotal ?? 0}
                  </span>
                ),
              },
              {
                header: 'Spend',
                cell: (mission) => (
                  <div className="space-y-0.5">
                    <p data-testid="mission-row-spend" className="font-mono text-xs text-slate-700">
                      {formatCost(mission.spendUsd ?? 0)}
                    </p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {mission.budget?.maxCostUsd === undefined
                        ? 'no cap'
                        : `cap ${formatCost(mission.budget.maxCostUsd)}`}
                    </p>
                  </div>
                ),
              },
              {
                header: 'Updated',
                cell: (mission) => (
                  <TimeAgo
                    value={mission.updatedAt ?? mission.createdAt}
                    testId="mission-row-updated"
                    className="text-[11px] text-slate-500"
                  />
                ),
              },
            ]}
          />
        </Card>
      )}
    </div>
  );
}
