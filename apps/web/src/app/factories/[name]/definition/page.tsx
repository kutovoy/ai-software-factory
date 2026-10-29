import { FactoryStubPage } from '@/components/factory/FactoryStubPage';

export const dynamic = 'force-dynamic';

export default async function DefinitionPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return (
    <FactoryStubPage
      factory={decodeURIComponent(name)}
      title="Definition"
      phase="Phase 2b — task 4.6 (next in this change)"
      description="The resource tree, the resolved gates table, the version (commit, tag, content hash) and a semantic diff against the previous version."
      bullets={[
        'Reads GET /factories/:name, /resources, /versions and /diff — all already live on the API',
        'Diff via @factory/core semantic diff (added / removed / changed with JSON pointers)',
        'No editing: definitions round-trip to git, never to the UI',
      ]}
    />
  );
}
