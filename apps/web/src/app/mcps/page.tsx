import { McpPanel } from '@/components/mcp/McpPanel';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getOrError, safeGet } from '@/lib/api';
import { countLabel } from '@/lib/factory';
import type { FactoryListItem, McpProjectionWire } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * MCPs and apps (spec `mcp-integration`, ADR-027): declared servers, transport, presence,
 * agents bound, tool globs and a runner-side connection test. The definition is the source
 * of truth; this page never edits it.
 */
export default async function McpsPage({
  searchParams,
}: {
  searchParams: Promise<{ factory?: string }>;
}) {
  const params = await searchParams;
  const factories = await safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] });
  // Factories are addressed by id (change `add-factory-identity`); the label stays human.
  const entries = factories.factories.map((entry) => ({
    id: entry.id ?? entry.key,
    name: entry.alias?.trim() || entry.name,
  }));
  const requested = params.factory ? decodeURIComponent(params.factory) : undefined;
  const selected =
    entries.find((entry) => entry.id === requested) ?? entries[0] ?? null;
  const factoryId = selected?.id ?? null;
  const factory = selected?.name ?? 'no factory';

  const projection = factoryId
    ? await getOrError<McpProjectionWire>(
        `/factories/${encodeURIComponent(factoryId)}/mcp`,
      )
    : { data: null, error: null };

  const unregistered = (projection.data?.servers ?? [])
    .filter((server) => !server.registered)
    .map((server) => server.name);

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">MCPs and apps</h1>
          <p className="text-sm text-slate-500">
            Servers declared in the definition, bound per agent with explicit tool permissions.
            Credentials are secret names, resolved outside the sandbox.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {entries.map((entry) => (
            <a
              key={entry.id}
              href={`/mcps?factory=${encodeURIComponent(entry.id)}`}
              data-testid="mcp-factory-link"
              data-factory={entry.name}
              className={`rounded-md border px-2 py-1 text-xs ${
                entry.id === factoryId
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-300 text-slate-700'
              }`}
            >
              {entry.name}
            </a>
          ))}
        </div>
      </header>

      <Card testId="mcp-registry">
        <CardHeader
          title={`${factory} MCP servers`}
          hint="Transport, status, bound agents and the tool globs each agent receives."
          action={
            projection.data ? (
              <Badge tone="neutral" testId="mcp-server-count">
                {countLabel(projection.data.servers.length, 'server', 'servers')}
              </Badge>
            ) : null
          }
        />
        <CardBody>
          {projection.error ? (
            <EmptyState
              testId="mcp-unavailable"
              title="MCP wiring unavailable"
              description={`The API did not return this factory's MCP projection: ${projection.error.message}`}
            />
          ) : (
            <McpPanel
              factoryId={factoryId ?? ''}
              projection={projection.data as McpProjectionWire}
              unregistered={unregistered}
            />
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-slate-500" data-testid="mcp-note">
        A connection test spawns the command (stdio) or calls the URL (http) inside the runner —
        never in the API process. A failure marks the server <span className="font-semibold">unhealthy</span>;
        agents bound to it still validate, because the failure is runtime, not definitional.
      </p>
    </div>
  );
}
