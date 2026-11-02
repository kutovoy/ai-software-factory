import Link from 'next/link';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { getOrError, safeGet } from '@/lib/api';
import { factoryNameOf, loadFactory } from '@/lib/factory-page';
import { GATE_STAGES, describeValue, groupResources } from '@/lib/definition';
import { formatDateTime, shortCommit } from '@/lib/format';
import type {
  FactoryDetail,
  FactoryDiff,
  FactoryResources,
  FactoryVersionEntry,
  GateStage,
} from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

export default async function DefinitionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { id } = await params;
  const { from, to } = await searchParams;
  const factory = decodeURIComponent(id);
  const encoded = encodeURIComponent(factory);
  const basePath = `/factories/${encoded}/definition`;

  const [detail, resources, versions] = await Promise.all([
    loadFactory(factory),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
    safeGet<{ versions: FactoryVersionEntry[] }>(`/factories/${encoded}/versions?limit=20`, {
      versions: [],
    }),
  ]);

  const factoryName = factoryNameOf(detail, factory);
  const version = detail?.version ?? null;
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  // Default `to` is the factory's pinned version commit, not HEAD: a later commit that
  // does not touch this directory would make the comparison look confusingly unrelated.
  const target = to ?? version?.commit ?? null;
  if (target) query.set('to', target);
  const diffResult = await getOrError<FactoryDiff>(
    `/factories/${encoded}/diff${query.toString() ? `?${query.toString()}` : ''}`,
  );

  const gates = detail?.gates ?? null;
  const stageRows: GateStage[] = gates
    ? GATE_STAGES.map((stage) => gates.stages[stage]).filter((row): row is GateStage => Boolean(row))
    : [];
  const groups = groupResources(resources?.resources ?? []);
  const versionEntries = versions.versions;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(detail?.alias, factoryName, 'Definition')}
          </h1>
          <p className="text-sm text-slate-500">
            Resource tree, resolved gates, version and a semantic diff — read straight from{' '}
            <span className="font-mono">factories/{detail?.key ?? factory}</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" testId="definition-resource-count">
            {resources?.resources.length ?? 0} resources
          </Badge>
          {version ? (
            <Badge tone="neutral" mono testId="definition-short-commit">
              {version.shortCommit}
            </Badge>
          ) : null}
          {version?.tag ? (
            <Badge tone="info" mono testId="definition-tag">
              {version.tag}
            </Badge>
          ) : null}
        </div>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="definition-readonly-banner" />

      <div className="grid gap-4 md:grid-cols-2">
        <Card testId="definition-version">
          <CardHeader
            title="Version"
            hint="A factory version = a git tag (factory-vN) + the commit SHA of the definition repo."
          />
          <CardBody>
            {version ? (
              <dl className="grid grid-cols-[8rem,1fr] gap-y-2 text-sm">
                <dt className="text-slate-500">Commit</dt>
                <dd data-testid="definition-version-commit" className="break-all font-mono text-xs text-slate-800">
                  {version.commit}
                </dd>
                <dt className="text-slate-500">Short</dt>
                <dd className="font-mono text-xs text-slate-800">{version.shortCommit}</dd>
                <dt className="text-slate-500">Tag</dt>
                <dd data-testid="definition-version-tag" className="font-mono text-xs text-slate-800">
                  {version.tag ?? 'untagged'}
                </dd>
                <dt className="text-slate-500">Content hash</dt>
                <dd
                  data-testid="definition-version-hash"
                  className="break-all font-mono text-[11px] text-slate-600"
                >
                  {version.contentHash ?? '—'}
                </dd>
                <dt className="text-slate-500">Worktree</dt>
                <dd>
                  <Badge
                    tone={version.dirty ? 'warning' : 'success'}
                    testId="definition-version-dirty"
                  >
                    {version.dirty ? 'dirty — uncommitted changes' : 'clean'}
                  </Badge>
                </dd>
                {versionEntries[0] ? (
                  <>
                    <dt className="text-slate-500">Latest commit</dt>
                    <dd className="text-xs text-slate-600">
                      {formatDateTime(versionEntries[0].date)} · {versionEntries[0].message}
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <EmptyState
                testId="definition-version-missing"
                title="Not versioned"
                description="This directory is not inside a git repository, so it has no commit, tag or content hash."
              />
            )}
          </CardBody>
        </Card>

        <Card testId="definition-gates">
          <CardHeader
            title="Resolved gates"
            hint="automation override → factory gates → global default."
          />
          <CardBody className="space-y-3">
            {stageRows.length === 0 ? (
              <EmptyState
                testId="definition-gates-missing"
                title="No gate resolution"
                description="The factory manifest could not be loaded, so gates cannot be resolved."
              />
            ) : (
              <>
                <Table
                  testId="definition-gates-table"
                  rowTestId="definition-gate-row"
                  rows={stageRows}
                  rowKey={(row) => row.stage}
                  columns={[
                    { header: 'Stage', cell: (row) => <span className="font-mono text-xs">{row.stage}</span> },
                    {
                      header: 'Gate',
                      cell: (row) => (
                        <span data-testid="definition-gate-value">
                          <Badge tone={row.gate === 'human' ? 'warning' : 'success'} mono>
                            {row.gate}
                          </Badge>
                        </span>
                      ),
                    },
                    {
                      header: 'Source',
                      cell: (row) => (
                        <span data-testid="definition-gate-source" className="text-xs text-slate-600">
                          {row.source}
                        </span>
                      ),
                    },
                  ]}
                />
                <p className="text-xs text-slate-500">
                  Merge policy{' '}
                  <span data-testid="definition-merge-policy" className="font-mono text-slate-700">
                    {gates?.mergePolicy}
                  </span>
                  {' · '}
                  {gates?.fullyAutonomous ? 'fully autonomous (lights off)' : 'lights on'}
                  {gates?.benchmarkGateRequired ? ' · benchmark gate required' : ''}
                </p>
              </>
            )}
          </CardBody>
        </Card>
      </div>

      <Card testId="definition-resource-tree">
        <CardHeader
          title="Resource tree"
          hint="Path-is-identity: each resource is one file under the definition root."
        />
        <CardBody>
          {groups.length === 0 ? (
            <EmptyState
              testId="definition-resources-empty"
              title="No resources"
              description="The definition could not be loaded or declares no resources beyond factory.yaml."
            />
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.kind} data-testid="definition-resource-group" data-kind={group.kind}>
                  <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {group.label}
                    <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600">
                      {group.resources.length}
                    </span>
                  </h3>
                  <ul className="divide-y divide-slate-100">
                    {group.resources.map((resource) => (
                      <li
                        key={resource.path}
                        data-testid="definition-resource-row"
                        data-kind={resource.kind}
                        data-name={resource.name}
                        className="grid gap-1 py-1.5 sm:grid-cols-[12rem,14rem,1fr]"
                      >
                        <span className="font-mono text-xs font-medium text-slate-900">{resource.name}</span>
                        <span className="font-mono text-[11px] text-slate-400">{resource.path}</span>
                        <span className="text-xs text-slate-600">{resource.summary}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card testId="definition-diff">
        <CardHeader
          title="Semantic diff"
          hint="Parsed documents compared field-by-field with JSON pointers — formatting noise is ignored."
        />
        <CardBody className="space-y-4">
          <form
            method="get"
            action={basePath}
            data-testid="definition-diff-form"
            className="flex flex-wrap items-end gap-3"
          >
            <div>
              <label htmlFor="diff-from" className="block text-xs font-medium text-slate-600">
                From
              </label>
              <select
                id="diff-from"
                name="from"
                data-testid="definition-diff-from"
                defaultValue={from ?? ''}
                className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">Previous version (default)</option>
                {versionEntries.map((entry) => (
                  <option key={entry.commit} value={entry.commit}>
                    {entry.shortCommit}
                    {entry.tag ? ` (${entry.tag})` : ''} — {entry.message.slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="diff-to" className="block text-xs font-medium text-slate-600">
                To
              </label>
              <select
                id="diff-to"
                name="to"
                data-testid="definition-diff-to"
                defaultValue={to ?? ''}
                className="mt-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                <option value="">Current version (default)</option>
                {versionEntries.map((entry) => (
                  <option key={entry.commit} value={entry.commit}>
                    {entry.shortCommit}
                    {entry.tag ? ` (${entry.tag})` : ''} — {entry.message.slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              data-testid="definition-diff-submit"
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              Compare
            </button>
            {from || to ? (
              <Link
                href={basePath}
                data-testid="definition-diff-reset"
                className="text-sm text-slate-500 underline decoration-slate-300 underline-offset-2"
              >
                Reset
              </Link>
            ) : null}
          </form>

          {diffResult.error ? (
            <div
              data-testid="definition-diff-error"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              <p className="font-medium">Diff unavailable ({diffResult.error.code})</p>
              <p className="text-xs">{diffResult.error.message}</p>
            </div>
          ) : diffResult.data ? (
            <div className="space-y-3">
              <p className="text-xs text-slate-600" data-testid="definition-diff-range">
                <span className="font-mono">
                  {diffResult.data.from.commit ? shortCommit(diffResult.data.from.commit) : 'no previous version'}
                  {diffResult.data.from.tag ? ` (${diffResult.data.from.tag})` : ''}
                </span>
                {' → '}
                <span className="font-mono">
                  {shortCommit(diffResult.data.to.commit)}
                  {diffResult.data.to.tag ? ` (${diffResult.data.to.tag})` : ''}
                </span>
              </p>

              {versionEntries.length <= 1 && !from && !to ? (
                <EmptyState
                  testId="definition-diff-single-version"
                  title="Only one version recorded"
                  description={`${version ? version.shortCommit : 'This definition'} is the first and only commit that touches this directory, so there is no previous version to compare against yet.`}
                />
              ) : diffResult.data.diff.isEmpty ? (
                <EmptyState
                  testId="definition-diff-empty"
                  title="No semantic changes"
                  description="The parsed documents are identical between these versions; only formatting may differ."
                />
              ) : (
                <div className="space-y-4" data-testid="definition-diff-changes">
                  {diffResult.data.diff.added.length > 0 ? (
                    <section data-testid="definition-diff-added">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        Added
                      </h3>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {diffResult.data.diff.added.map((ref) => (
                          <li key={`${ref.kind}:${ref.name}`} data-testid="definition-diff-added-item">
                            <span className="font-mono text-xs text-emerald-700">+ {ref.kind}:{ref.name}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {diffResult.data.diff.removed.length > 0 ? (
                    <section data-testid="definition-diff-removed">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-red-700">Removed</h3>
                      <ul className="mt-1 space-y-0.5 text-sm">
                        {diffResult.data.diff.removed.map((ref) => (
                          <li key={`${ref.kind}:${ref.name}`} data-testid="definition-diff-removed-item">
                            <span className="font-mono text-xs text-red-700">- {ref.kind}:{ref.name}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {diffResult.data.diff.changed.length > 0 ? (
                    <section data-testid="definition-diff-changed">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Changed
                      </h3>
                      <div className="mt-1 space-y-3">
                        {diffResult.data.diff.changed.map((resource) => (
                          <div
                            key={`${resource.kind}:${resource.name}`}
                            data-testid="definition-diff-changed-resource"
                            data-resource={`${resource.kind}:${resource.name}`}
                            className="rounded-lg border border-slate-200 px-3 py-2"
                          >
                            <p className="font-mono text-xs font-medium text-slate-900">
                              {resource.kind}:{resource.name}
                            </p>
                            <ul className="mt-1 space-y-1">
                              {resource.changes.map((change) => (
                                <li
                                  key={`${change.pointer}-${describeValue(change.old)}`}
                                  data-testid="definition-diff-change"
                                  className="grid min-w-0 gap-1 text-xs sm:grid-cols-[14rem,1fr,1fr]"
                                >
                                  <span className="min-w-0 break-all font-mono text-slate-500">
                                    {change.pointer || '/'}
                                  </span>
                                  <span className="min-w-0 break-all font-mono text-red-700">
                                    {describeValue(change.old)}
                                  </span>
                                  <span className="min-w-0 break-all font-mono text-emerald-700">
                                    {describeValue(change.new)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              testId="definition-diff-missing"
              title="No diff"
              description="The API returned no comparison for these versions."
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
