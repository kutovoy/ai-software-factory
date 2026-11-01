'use client';

import { useState } from 'react';

/**
 * Copies a value to the clipboard. Used where a truncated identifier (a commit SHA, a
 * workflow id) has to stay readable without widening its metadata cell.
 */
export function CopyButton({
  value,
  label = 'Copy',
  testId,
}: {
  value: string;
  label?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied (insecure context); the full value stays in `title`.
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void copy()}
      title={copied ? 'Copied' : `${label}: ${value}`}
      className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
    >
      {copied ? 'copied' : label}
    </button>
  );
}
