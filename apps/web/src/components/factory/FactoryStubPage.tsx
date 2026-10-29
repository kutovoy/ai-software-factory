import { ComingSoon } from '@/components/ui/ComingSoon';

/** Shared shell for factory pages that ship in a later phase. */
export function FactoryStubPage({
  factory,
  title,
  phase,
  description,
  bullets,
}: {
  factory: string;
  title: string;
  phase: string;
  description: string;
  bullets?: string[];
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">
          {factory} <span className="text-slate-400">›</span> {title}
        </h1>
        <p className="text-sm text-slate-500">
          Definitions are edited in git; this console only ever displays them.
        </p>
      </header>
      <ComingSoon title={title} phase={phase} description={description} bullets={bullets} />
    </div>
  );
}
