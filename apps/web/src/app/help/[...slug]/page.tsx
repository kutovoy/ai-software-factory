import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiExplorer } from '@/components/help/ApiExplorer';
import { ApiReference } from '@/components/help/ApiReference';
import { HelpBlocks, RelatedLinks } from '@/components/help/HelpBlocks';
import { Badge } from '@/components/ui/Badge';
import { HELP_SECTIONS, getHelpEntry } from '@/lib/help';

interface HelpPageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: HelpPageProps): Promise<Metadata> {
  const { slug } = await params;
  const entry = getHelpEntry((slug ?? []).join('/'));
  return {
    title: entry ? `${entry.title} — Help` : 'Help — Software Factory',
    description: entry?.summary,
  };
}

/** `/help/<slug>` (slugs may contain `/`, e.g. `factories/add`). */
export default async function HelpEntryPage({ params }: HelpPageProps) {
  const { slug } = await params;
  const key = (slug ?? []).join('/');
  const entry = getHelpEntry(key);
  if (!entry) notFound();

  const section = HELP_SECTIONS.find((meta) => meta.id === entry.section);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-6 py-6">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link
          href="/help"
          data-testid="help-back-link"
          className="text-slate-600 underline decoration-slate-300 underline-offset-2 hover:text-slate-900"
        >
          ← All help
        </Link>
        {section ? (
          <span data-testid="help-entry-section" className="text-slate-400">
            {section.title}
          </span>
        ) : null}
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 data-testid="help-entry-title" className="text-lg font-semibold text-slate-900">
            {entry.title}
          </h1>
          <Badge tone="neutral" testId="help-entry-status">
            {entry.status}
          </Badge>
        </div>
        <p data-testid="help-entry-summary" className="max-w-prose text-sm text-slate-500">
          {entry.summary}
        </p>
        {entry.pageHref ? (
          <p className="text-sm">
            <Link
              href={entry.pageHref}
              data-testid="help-page-link"
              className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2"
            >
              {entry.pageHrefLabel ?? `Open ${entry.title} →`}
            </Link>
          </p>
        ) : null}
      </header>

      <article data-testid="help-entry" data-slug={entry.slug} className="space-y-5">
        {entry.renderer === 'api-reference' ? (
          <>
            <div
              data-testid="api-explorer-banner"
              className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="font-semibold">Actions run against this stack</p>
              <p className="mt-1 max-w-prose text-xs leading-5">
                &ldquo;Try it out&rdquo; sends real requests — including <span className="font-mono">POST</span>,{' '}
                <span className="font-mono">PUT</span>, <span className="font-mono">PATCH</span> and{' '}
                <span className="font-mono">DELETE</span> calls that change runs, work items, gates, secrets and
                factories. The local API has <strong>no authentication</strong>: it runs as a single implicit local
                user, so anything you can read here you can also change. Requests go to the console origin
                (<span className="font-mono">/api/v1/…</span>) and are proxied server-side to the API — no CORS, and
                the API host never appears in the browser.
              </p>
            </div>

            <section data-testid="api-explorer-section" className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">Live explorer</h2>
                <p className="text-xs text-slate-500">
                  Swagger UI · execute against this stack · same-origin proxy
                </p>
              </div>
              <ApiExplorer />
            </section>
          </>
        ) : null}

        <HelpBlocks blocks={entry.blocks} />

        {entry.renderer === 'api-reference' ? (
          <section data-testid="api-static-reference" className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-slate-900">Static reference (no-JS fallback)</h2>
              <p className="max-w-prose text-xs leading-5 text-slate-500">
                Server-rendered from the same document, so it stays readable when JavaScript is unavailable or the
                explorer cannot start. It lists what is served; the explorer is where you execute it.
              </p>
            </div>
            <ApiReference />
          </section>
        ) : null}
      </article>

      <RelatedLinks links={entry.related} />

      <footer className="border-t border-slate-200 pt-3 text-xs text-slate-500">
        <p>
          Registry entry <span className="font-mono">{entry.slug}</span> · help content lives in{' '}
          <span className="font-mono">apps/web/src/lib/help.ts</span>. If this page disagrees with the product, the
          product is right — fix the entry in the same change.
        </p>
      </footer>
    </div>
  );
}
