import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function ScorersPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Scorers"
      phase="Phase 4 — measurement"
      description="LLM-as-judge scorers over real runs: weighted classifications, passing score, sampling rate, and the judge model version + prompt hash."
      bullets={[
        'Per-scorer pass rate, counts and the agents it applies to',
        'Deterministic checks (tests, lint, build) run first and are free',
        'Judge calibration against a golden set before self-improvement can use scores',
      ]}
    />
  );
}
