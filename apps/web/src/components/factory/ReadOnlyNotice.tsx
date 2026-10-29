/**
 * The banner every definition-backed page carries. The console is a projection of git;
 * it never writes a definition (ADR-012, `web-console` spec).
 */
export function ReadOnlyNotice({
  path,
  testId,
}: {
  path: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      role="note"
      className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p className="font-semibold">Definitions are edited in git — this page is read-only.</p>
      <p className="mt-1 text-xs text-amber-800">
        Source of truth: <span className="font-mono">{path}</span>. Make changes in the definition
        repository; nothing here is editable and nothing is written back.
      </p>
    </div>
  );
}
