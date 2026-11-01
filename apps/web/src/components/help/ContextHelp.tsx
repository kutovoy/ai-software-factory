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
      className="sticky top-0 z-10 flex items-center justify-end border-b border-slate-200 bg-white/95 px-6 py-1.5 backdrop-blur"
    >
      <Link
        href={context.href}
        data-testid="help-context-link"
        data-help-slug={context.slug ?? 'index'}
        aria-label={`Help for ${context.pageName}`}
        title={`Help for ${context.pageName}`}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
      >
        <span
          aria-hidden="true"
          className="flex h-4 w-4 items-center justify-center rounded-full border border-slate-300 text-[10px] leading-none"
        >
          ?
        </span>
        Help
      </Link>
      <AutoRefresh />
    </header>
  );
}
