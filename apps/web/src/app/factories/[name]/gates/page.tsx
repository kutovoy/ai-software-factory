import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function GatesPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Gates"
      phase="Phase 2b — task 4.7 (display) · Phase 3 (decisions)"
      description="Every stage with its resolved gate (human / agent / policy:<name>), the resolution source (automation → factory → global), the merge policy and the autonomy flag."
      bullets={[
        'A fully autonomous factory is flagged with its benchmark-gate requirement',
        'Gate decisions and escalation timers ship in Phase 3',
        'Until then, human gates are actionable through the Inbox',
      ]}
    />
  );
}
