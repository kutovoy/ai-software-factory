import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function BenchmarksPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Benchmarks"
      phase="Phase 4 — measurement"
      description="Suites pinned to a starting repo ref and a definition commit, replayed hermetically, compared across factory versions — not just models."
      bullets={[
        'Correctness-vs-cost Pareto matrix per configuration',
        'Compare two definitionCommits side by side',
        'Benchmark gate is what unlocks lights-off autonomy',
      ]}
    />
  );
}
