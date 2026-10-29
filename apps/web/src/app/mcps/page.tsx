import { ComingSoon } from '@/components/ui/ComingSoon';

export const dynamic = 'force-dynamic';

export default function McpsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">MCPs and apps</h1>
        <p className="text-sm text-slate-500">Connections the factory can use, declared in git.</p>
      </header>
      <ComingSoon
        title="MCPs and apps"
        phase="Phase 6 — team & cloud"
        description="MCP servers and app integrations declared in factory.yaml, with their auth source and which agents may use them."
        bullets={[
          'Server names only — credentials are resolved outside the sandbox (ADR-011)',
          'Per-agent allow/deny lists, absent in the reference product',
          'Requires the secrets store, which ships in Phase 6',
        ]}
      />
    </div>
  );
}
