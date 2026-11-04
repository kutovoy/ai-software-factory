import { Card, CardHeader } from '@/components/ui/Card';

/**
 * Honest loading state: the shell renders immediately, the projection streams in. No
 * fabricated counts or rows (performance plan, Phase 6).
 */
export default function InboxLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6" aria-busy="true">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Inbox</h1>
        <p className="text-sm text-slate-500">Loading items that need you…</p>
      </header>

      <Card testId="inbox-loading-gates">
        <CardHeader title="Gate approvals" hint="Loading pending gates." />
        <div className="space-y-2 px-5 py-4">
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-4 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </Card>

      <Card testId="inbox-loading-permissions">
        <CardHeader title="Pending permissions" hint="Loading blocked runs." />
        <div className="space-y-2 px-5 py-4">
          {[0, 1].map((row) => (
            <div key={row} className="h-4 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </Card>
    </div>
  );
}
