'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AutoRefresh } from '@/components/nav/AutoRefresh';
import { helpContextForPath } from '@/lib/help';

/**
 * Shared header control (`web-console` spec: "Contextual help"). The route → slug map
 * lives in `lib/help.ts`; an unknown route links to the index instead of a 404, and the
 * accessible name names the page so a screen reader says what the help is for.
 */
export function ContextHelp() {
  const pathname = usePathname() ?? '/';
  const context = helpContextForPath(pathname);

  return (
    <header
      data-testid="help-bar"
      className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-slate-800 bg-slate-950 px-5 text-slate-200"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="font-semibold tracking-tight text-slate-100">Software Factory</span>
        <span className="text-slate-600">/</span>
        <span className="truncate text-slate-400">{context.pageName}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <AutoRefresh />
        <Link
          href={context.href}
          data-testid="help-context-link"
          data-help-slug={context.slug ?? 'index'}
          aria-label={`Help for ${context.pageName}`}
          title={`Help for ${context.pageName}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
        >
          <span
            aria-hidden="true"
            className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-600 text-[10px] leading-none text-slate-400"
          >
            ?
          </span>
          Help
        </Link>
      </div>
    </header>
  );
}
