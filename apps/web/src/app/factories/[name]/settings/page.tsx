import Link from 'next/link';
import { GithubIntegrationForm } from '@/components/integrations/GithubIntegrationForm';
import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import { getOrError, safeGet } from '@/lib/api';
import type { FactoryDetail, IntegrationsResponseWire } from '@/lib/types';
import { factoryHeading } from '@/lib/factory';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, integrations] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    getOrError<IntegrationsResponseWire>(`/factories/${encoded}/integrations`),
  ]);
  const manifest = detail?.factory.manifest ?? null;
  const version = detail?.factory.version ?? null;
  const github = integrations.data?.github ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {factoryHeading(detail?.factory.alias, factory, 'Settings')}
          </h1>
          <p className="text-sm text-slate-500">
            Factory-level manifest: repositories, agent defaults, secrets (names only) and integrations.
          </p>
        </div>
        {version ? (
          <Badge tone="neutral" mono testId="settings-version">
            {version.shortCommit}
            {version.tag ? ` · ${version.tag}` : ''}
          </Badge>
        ) : null}
      </header>

      <ReadOnlyNotice path={`factories/${factory}/factory.yaml`} testId="settings-readonly-banner" />

      {manifest ? (
        <>
          <Card testId="settings-manifest">
            <CardHeader title="Manifest" hint="factory.yaml" />
            <CardBody>
              <dl className="grid gap-2 text-sm sm:grid-cols-[10rem,1fr]">
                <dt className="text-slate-500">Schema version</dt>
                <dd data-testid="settings-schema-version" className="font-mono text-xs text-slate-800">
                  {manifest.schemaVersion}
                </dd>
                <dt className="text-slate-500">Name</dt>
                <dd className="font-mono text-xs text-slate-800">{manifest.name}</dd>
                <dt className="text-slate-500">Alias</dt>
                <dd className="text-xs text-slate-800">{manifest.alias ?? '—'}</dd>
                <dt className="text-slate-500">Description</dt>
                <dd className="text-xs text-slate-700">{manifest.description ?? '—'}</dd>
                <dt className="text-slate-500">Merge policy</dt>
                <dd data-testid="settings-merge-policy" className="font-mono text-xs text-slate-800">
                  {manifest.mergePolicy}
                </dd>
                <dt className="text-slate-500">Agent defaults</dt>
                <dd data-testid="settings-agent-defaults" className="font-mono text-xs text-slate-700">
                  {manifest.agentDefaults.harness
                    ? `${manifest.agentDefaults.harness.type} · ${manifest.agentDefaults.harness.model}`
                    : manifest.agentDefaults.model ?? '—'}
                  {manifest.agentDefaults.runner ? ` · runner ${manifest.agentDefaults.runner}` : ''}
                </dd>
              </dl>
            </CardBody>
          </Card>

          <Card testId="settings-repositories">
            <CardHeader title="Repositories" hint="The code forges this factory works on." />
            <CardBody>
              <Table
                testId="settings-repositories-table"
                rowTestId="settings-repository-row"
                rows={manifest.repositories}
                rowKey={(row) => `${row.owner}/${row.name}`}
                columns={[
                  {
                    header: 'Owner',
                    cell: (row) => <span className="font-mono text-xs text-slate-800">{row.owner}</span>,
                  },
                  {
                    header: 'Name',
                    cell: (row) => <span className="font-mono text-xs text-slate-800">{row.name}</span>,
                  },
                ]}
              />
            </CardBody>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card testId="settings-secrets">
              <CardHeader title="Secrets" hint="Names only — values never leave the secrets store." />
              <CardBody>
                {manifest.secrets.length === 0 ? (
                  <p className="text-xs text-slate-500">No factory-wide secret references.</p>
                ) : (
                  <div data-testid="settings-secret-names" className="flex flex-wrap gap-1">
                    {manifest.secrets.map((secret) => (
                      <Badge key={secret} tone="neutral" mono>
                        {secret}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>

            <Card testId="settings-integrations">
              <CardHeader title="Integrations" hint="Declared connections; wiring is not active yet." />
              <CardBody>
                {(manifest.integrations ?? []).length === 0 ? (
                  <p className="text-xs text-slate-500">No integrations declared.</p>
                ) : (
                  <div data-testid="settings-integration-names" className="flex flex-wrap gap-1">
                    {(manifest.integrations ?? []).map((integration) => (
                      <Badge key={integration} tone="info">
                        {integration}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

      <Card testId="settings-github-integration">
        <CardHeader
          title="GitHub connection"
          hint="A token secret reference, the repositories it may act on, the webhook URL and the dry-run switch."
          action={
            github ? (
              <Badge
                tone={github.configured && github.secretConfigured ? 'success' : 'warning'}
                testId="settings-github-status"
              >
                {github.configured
                  ? github.secretConfigured
                    ? github.dryRun
                      ? 'dry run'
                      : 'connected'
                    : 'secret missing'
                  : 'not configured'}
              </Badge>
            ) : null
          }
        />
        <CardBody className="space-y-4 text-sm">
          {integrations.error ? (
            <p data-testid="settings-github-error" className="text-xs text-red-700">
              {integrations.error.message}
            </p>
          ) : null}
          {github ? (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-[11rem,1fr]">
                <dt className="text-slate-500">Token secret ref</dt>
                <dd data-testid="settings-github-secret-ref" className="font-mono text-xs text-slate-800">
                  {github.secretRef ?? '—'} {github.secretConfigured ? '· resolved' : '· not in the environment'}
                </dd>
                <dt className="text-slate-500">Webhook secret ref</dt>
                <dd data-testid="settings-github-webhook-secret-ref" className="font-mono text-xs text-slate-800">
                  {github.webhookSecretRef ?? '—'} {github.webhookSecretConfigured ? '· resolved' : '· not in the environment'}
                </dd>
                <dt className="text-slate-500">Webhook URL</dt>
                <dd data-testid="settings-github-webhook-url" className="break-all font-mono text-xs text-slate-800">
                  {github.webhookUrl}
                </dd>
                <dt className="text-slate-500">Filters</dt>
                <dd data-testid="settings-github-filters" className="text-xs text-slate-700">
                  events {github.events.join(', ')} · labels {github.labels.join(', ') || 'any'} · branch{' '}
                  {github.branch ?? 'any'} · bots {github.skipBots}
                </dd>
                <dt className="text-slate-500">Merge ownership</dt>
                <dd data-testid="settings-github-merge-queue" className="text-xs text-slate-700">
                  {github.mergeQueue ? 'the merge queue owns merges' : 'the loop merges on a green ship gate'}
                </dd>
              </dl>

              {github.repos.length === 0 ? (
                <p data-testid="settings-github-repos-empty" className="text-xs text-slate-500">
                  No repositories configured: the webhook route ignores every delivery until one is added.
                </p>
              ) : (
                <Table
                  testId="settings-github-repos-table"
                  rowTestId="settings-github-repo-row"
                  rows={github.repos}
                  rowKey={(row) => `${row.owner}/${row.name}`}
                  columns={[
                    {
                      header: 'Repository',
                      cell: (row) => (
                        <span className="font-mono text-xs text-slate-800">
                          {row.owner}/{row.name}
                        </span>
                      ),
                    },
                  ]}
                />
              )}

              <GithubIntegrationForm factory={factory} integration={github} />
            </>
          ) : (
            <EmptyState
              testId="settings-github-unavailable"
              title="Integration settings unavailable"
              description="The API did not return this factory's integration settings."
            />
          )}
        </CardBody>
      </Card>

      <Card testId="settings-local-forge">
        <CardHeader
          title="Local forge"
          hint="Forgejo, served by this console at /extras/forgejo/ — pull request links recorded by the factory open here."
          action={
            <Badge tone="info" testId="settings-forgejo-mode">
              console identity
            </Badge>
          }
        />
        <CardBody className="space-y-3 text-sm">
          <p className="text-xs text-slate-600">
            The console proxies <span className="font-mono">/extras/forgejo/</span> to the local Forgejo instance,
            resolves the session through <span className="font-mono">/auth/me</span> and asserts the signed-in username
            with a trusted header, so there is no second password prompt. Signed out with auth required, forge pages
            redirect to <span className="font-mono">/login</span>; with auth off the proxy falls back to the seeded
            admin. The forge itself has no published host port.
          </p>
          <p className="text-xs text-slate-600">
            Each user gets a best-effort personal organization <span className="font-mono">u-&lt;username&gt;</span>.
            OIDC group→organization mapping (<span className="font-mono">FORGEJO_OIDC_GROUP_MAP</span>) is the
            documented path for a later IdP phase, not built yet. Keycloak is optional — any OIDC provider works.
          </p>
          <a
            href="/extras/forgejo/"
            data-testid="settings-open-forgejo"
            className="inline-block text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
          >
            Open Forgejo →
          </a>
        </CardBody>
      </Card>

          <Card testId="settings-mcps">
            <CardHeader
              title="MCP servers"
              hint="Declared in factory.yaml; credentials are secret names resolved at run time."
            />
            <CardBody>
              {(() => {
                const names = [
                  ...new Set([
                    ...((manifest.mcp?.servers ?? []).map((server) => server.name)),
                    ...Object.keys(manifest.mcpServers ?? {}),
                  ]),
                ];
                if (names.length === 0) {
                  return <p className="text-xs text-slate-500">No MCP servers declared.</p>;
                }
                return (
                  <div data-testid="settings-mcp-names" className="flex flex-wrap gap-1">
                    {names.map((server) => (
                      <Badge key={server} tone="neutral" mono>
                        {server}
                      </Badge>
                    ))}
                  </div>
                );
              })()}
            </CardBody>
          </Card>
        </>
      ) : (
        <EmptyState
          testId="settings-empty"
          title="Manifest unavailable"
          description="The API did not return this factory's manifest, so there is nothing to display."
        />
      )}

      <Card testId="settings-delete-factory">
        <CardHeader
          title="Delete this factory"
          hint="Git-backed removal — the console never writes the worktree"
        />
        <CardBody className="space-y-2 text-sm text-slate-700">
          <p>
            There is no delete button by design. Deleting means removing the definition directory, pausing its
            automations and clearing its read-model rows; git history keeps the definition.
          </p>
          <pre className="overflow-x-auto rounded bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700">
            bun scripts/delete-factory.ts {factory} --yes
          </pre>
          <p className="text-xs text-slate-500">
            The script refuses while work items are active or runs are live (use <span className="font-mono">--force</span>{' '}
            to override), then reminds you to commit the removal.
          </p>
          <Link
            href="/help/factories/delete"
            className="inline-block text-xs underline decoration-slate-300 underline-offset-2"
          >
            How deletion works →
          </Link>
        </CardBody>
      </Card>

      <div
        data-testid="settings-killswitch-note"
        className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <span className="font-semibold">The global kill switch arrives in Phase 6.</span> It flips every gate
        back to <span className="font-mono">human</span> across all factories. Repository identity and
        per-gate approvers need auth/users, which ship with team &amp; cloud — nothing here is editable until
        then.
      </div>
    </div>
  );
}
