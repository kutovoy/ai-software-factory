import { ReadOnlyNotice } from '@/components/factory/ReadOnlyNotice';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { safeGet } from '@/lib/api';
import { docOf, inference, type AgentDoc, type InferenceDoc } from '@/lib/definition';
import type { FactoryDetail, FactoryResources } from '@/lib/types';

export const dynamic = 'force-dynamic';

function Chips({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <span className="text-xs text-slate-400">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <Badge key={value} tone="neutral" mono>
          {value}
        </Badge>
      ))}
    </span>
  );
}

export default async function AgentsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const factory = decodeURIComponent(name);
  const encoded = encodeURIComponent(factory);

  const [detail, resources] = await Promise.all([
    safeGet<{ factory: FactoryDetail } | null>(`/factories/${encoded}`, null),
    safeGet<FactoryResources | null>(`/factories/${encoded}/resources`, null),
  ]);

  const defaults = (detail?.factory.manifest.agentDefaults ?? null) as InferenceDoc | null;
  const agents = (resources?.resources ?? []).filter((resource) => resource.kind === 'agent');

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">
            {detail?.factory.alias ?? factory} <span className="text-slate-400">›</span> Agents
          </h1>
          <p className="text-sm text-slate-500">
            Role, harness/model, runner, tool allow/deny lists, secret names and who may spawn each agent.
          </p>
        </div>
        <Badge tone="neutral" testId="agents-count">
          {agents.length} agents
        </Badge>
      </header>

      <ReadOnlyNotice path={`factories/${factory}`} testId="agents-readonly-banner" />

      <p className="text-xs text-slate-500" data-testid="agents-secrets-note">
        Secrets are shown by <span className="font-semibold">name only</span> — values never leave the
        secrets store and never appear in a definition, a run log or this page.
      </p>

      {agents.length === 0 ? (
        <EmptyState
          testId="agents-empty"
          title="No agents declared"
          description="The definition declares no resources under agents/."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((resource) => {
            const doc = docOf<AgentDoc>(resource);
            const selected = inference(doc, defaults);
            const secretNames = [
              ...new Set([
                ...(doc.secrets ?? []),
                ...(selected.auth?.secretName ? [selected.auth.secretName] : []),
              ]),
            ];
            const allow = doc.tools?.allow ?? [];
            const deny = doc.tools?.deny ?? [];
            const spawnableBy = doc.spawnableBy ?? [];

            return (
              <div
                key={resource.path}
                data-testid="agent-card"
                data-agent={resource.name}
                className="h-full"
              >
                <Card className="h-full">
                  <CardHeader
                    title={resource.name}
                    hint={doc.description ?? resource.summary}
                    action={
                      doc.role ? (
                        <Badge tone="info" testId="agent-role">
                          {doc.role}
                        </Badge>
                      ) : null
                    }
                  />
                  <CardBody className="space-y-3 text-sm">
                    <dl className="grid grid-cols-[7rem,1fr] gap-y-2">
                      <dt className="text-slate-500">Harness</dt>
                      <dd data-testid="agent-harness" className="font-mono text-xs text-slate-800">
                        {selected.harness ?? 'inherited / unresolved'}
                      </dd>
                      <dt className="text-slate-500">Model</dt>
                      <dd data-testid="agent-model" className="font-mono text-xs text-slate-800">
                        {selected.model ?? '—'}
                      </dd>
                      <dt className="text-slate-500">Runner</dt>
                      <dd data-testid="agent-runner" className="font-mono text-xs text-slate-800">
                        {doc.runner ?? detail?.factory.manifest.agentDefaults.runner ?? '—'}
                      </dd>
                      <dt className="text-slate-500">Secrets</dt>
                      <dd data-testid="agent-secrets">
                        <Chips values={secretNames} empty="none declared" />
                      </dd>
                      <dt className="text-slate-500">Spawnable by</dt>
                      <dd data-testid="agent-spawnable-by">
                        <Chips values={spawnableBy} empty="none — top-level agent" />
                      </dd>
                    </dl>

                    <div className="space-y-1">
                      <p className="text-xs font-medium text-slate-600">Tools allowed</p>
                      <div data-testid="agent-tools-allow">
                        <Chips values={allow} empty="no explicit allowlist" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-slate-600">Tools denied</p>
                      <div data-testid="agent-tools-deny">
                        <Chips values={deny} empty="nothing denied" />
                      </div>
                    </div>

                    <p className="font-mono text-[11px] text-slate-400">{resource.path}</p>
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
