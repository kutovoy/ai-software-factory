import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function SelfImprovementPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Self-improvement"
      phase="Phase 5 — self-improvement + versioned releases"
      description="Proposals clustered by root cause and ranked by impact (failed runs × cost), each backed by a benchmark non-regression gate before it can merge."
      bullets={[
        'Observer agents read scored runs and propose invariant / domain definition edits',
        'Top 3 proposals by impact, not 33 raw ones',
        'Never auto-applies without a benchmark win',
      ]}
    />
  );
}
