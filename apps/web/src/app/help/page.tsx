import type { Metadata } from 'next';
import Link from 'next/link';
import { HelpIndex } from '@/components/help/HelpIndex';
import { HELP_ENTRIES, HELP_SECTIONS } from '@/lib/help';

export const metadata: Metadata = {
  title: 'Help — Software Factory',
  description: 'In-product help: quick start, concepts, menu reference, setup how-tos and troubleshooting.',
};

/**
 * `/help` — the Diátaxis-grouped index (`web-console` spec: "Index"). Every row links to
 * a real registry entry; the filter is client-side over the same data.
 */
export default function HelpIndexPage() {
  const entries = HELP_ENTRIES.map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    section: entry.section,
    status: entry.status,
    summary: entry.summary,
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-6 py-6">
      <header className="space-y-1">
        <h1 data-testid="help-title" className="text-lg font-semibold text-slate-900">
          Help centre
        </h1>
        <p className="max-w-prose text-sm text-slate-500">
          Everything the console can do, grouped the way you need it: a quick start to get running, the concepts
          behind the loop, a reference for every menu item, setup how-tos and troubleshooting. Each entry states its
          real status — a stub says it is a stub.
        </p>
        <p className="text-xs text-slate-500">
          Every page also carries a <span className="font-mono">?</span> control in the top right that opens the entry
          for that page.
        </p>
      </header>

      <HelpIndex sections={HELP_SECTIONS} entries={entries} />

      <p className="text-xs text-slate-500">
        Help is part of the product: a page, route or capability change updates its entry in the same change. See{' '}
        <Link href="/help/factories/add" className="underline decoration-slate-300 underline-offset-2">
          Add a factory
        </Link>{' '}
        for the git-backed workflow the console never shortcuts.
      </p>
    </div>
  );
}
