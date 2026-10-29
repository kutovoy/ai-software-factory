export function Spinner({ label = 'Loading', testId = 'spinner' }: { label?: string; testId?: string }) {
  return (
    <span data-testid={testId} role="status" aria-live="polite" className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
      />
      {label}
    </span>
  );
}
