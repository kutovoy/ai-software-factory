import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
  testId = 'empty-state',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center"
    >
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description ? <p className="max-w-prose text-sm text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}
