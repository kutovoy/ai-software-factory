import { SecretsPanel } from '@/components/secrets/SecretsPanel';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getOrError } from '@/lib/api';
import type { SecretsResponseWire } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Secrets (spec `secrets`, ADR-026): a name-only registry with presence and usage.
 * Nothing on this page can show a value — the API never returns one.
 */
export default async function SecretsPage() {
  const secrets = await getOrError<SecretsResponseWire>('/secrets');

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Secrets</h1>
          <p className="text-sm text-slate-500">
            Named references only. The registry stores metadata, checks presence in the runtime
            environment and audits which runs used each name.
          </p>
        </div>
      </header>

      <p className="text-xs text-slate-500" data-testid="secrets-note">
        A name is not custody: this page can say whether a name <span className="font-semibold">resolves</span>,
        never whether it is correct. The first real run is the real test. Values live in the
        environment or the secret manager and never appear here, in a run log or in a definition.
      </p>

      <Card testId="secrets-registry">
        <CardHeader
          title="Registry"
          hint="Name, provider, scope, presence, last rotation and last use."
        />
        <CardBody>
          {secrets.error ? (
            <EmptyState
              testId="secrets-unavailable"
              title="The registry is unavailable"
              description={`The API did not return the secret registry: ${secrets.error.message}`}
            />
          ) : (
            <SecretsPanel
              secrets={secrets.data?.secrets ?? []}
              unregistered={secrets.data?.unregistered ?? []}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
