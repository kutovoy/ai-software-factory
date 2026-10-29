import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Settings"
      phase="Phase 6 — team & cloud"
      description="Factory-level settings: repositories, integrations, the global kill switch, and who may approve which gate."
      bullets={[
        'The kill switch flips every gate back to human',
        'Repository identity via short-lived GitHub App tokens, never a PAT',
        'Requires auth/users, which is Phase 6',
      ]}
    />
  );
}
