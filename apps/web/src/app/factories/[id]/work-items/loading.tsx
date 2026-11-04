import { Card, CardHeader } from '@/components/ui/Card';

/** Honest board skeleton: column headers render, cards stream in from the batch projection. */
export default function WorkItemsLoading() {
  return (
    <div className="mx-auto max-w-[110rem] space-y-4 px-6 py-6" aria-busy="true">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Work items</h1>
        <p className="text-sm text-slate-500">Loading the board…</p>
      </header>

      <Card testId="work-items-loading">
        <CardHeader title="Board" hint="Loading work items, pending gates and run links." />
        <div className="grid grid-flow-col auto-cols-[minmax(16rem,1fr)] gap-3 overflow-x-auto px-4 py-4">
          {[0, 1, 2, 3, 4, 5, 6].map((column) => (
            <section key={column} className="space-y-2 rounded-xl border border-slate-200 p-3">
              <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
              <div className="h-16 animate-pulse rounded bg-slate-100" />
            </section>
          ))}
        </div>
      </Card>
    </div>
  );
}
