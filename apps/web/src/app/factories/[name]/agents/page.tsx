import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Agents"
      phase="Phase 2b — task 4.8 (next in this change)"
      description="Each agent's role, harness/model, runner, tool allow/deny lists and secret names (names only, never values)."
      bullets={[
        'Foreman + sub-agent cards, one per resource under agents/',
        'Managed-in-git banner: configuration is read-only here',
        'Prompt body and automation triggers per agent',
      ]}
    />
  );
}
