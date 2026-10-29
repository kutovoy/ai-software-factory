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
        phase="Phase 3 — the factory loop + gates"
        description="MCP servers and app integrations declared in factory.yaml, with which agents may use them and where their credentials are resolved."
        bullets={[
          'Per-agent MCP allowlists, absent in the reference product',
          'Server names only — credentials are resolved outside the sandbox (ADR-011)',
          'The secrets store that backs them ships in Phase 6',
        ]}
      />
    </div>
  );
}
