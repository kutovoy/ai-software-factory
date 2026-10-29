import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Automations"
      phase="Phase 3 — the factory loop + gates"
      description="First-class entry points: which events start work (webhooks, schedules, chat), which agent handles it, and which stages it can skip."
      bullets={[
        'Automation resources already load from automations/<name>/automation.md',
        'Triggers, cron expressions and gate overrides will render read-only here',
        'Running an automation from the UI arrives with the Phase 3 workflow',
      ]}
    />
  );
}
