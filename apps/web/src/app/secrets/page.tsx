import { ComingSoon } from '@/components/ui/ComingSoon';

export const dynamic = 'force-dynamic';

export default function SecretsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Secrets</h1>
        <p className="text-sm text-slate-500">Named references only; values never leave the secrets store.</p>
      </header>
      <ComingSoon
        title="Secrets"
        phase="Phase 6 — team & cloud"
        description="The secret names a factory references, which agent/tool gets them, and rotation state. Inference credentials never enter a runner."
        bullets={[
          'Definitions reference secrets by name; values are resolved at run time',
          'Names only in this UI — never values, never logs',
          'Per-tool injection and rotation arrive with the secrets store',
        ]}
      />
    </div>
  );
}
