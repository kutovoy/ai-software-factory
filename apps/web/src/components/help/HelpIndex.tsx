'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { HelpSection, HelpSectionMeta } from '@/lib/help';

export interface HelpIndexItem {
  slug: string;
  title: string;
  section: HelpSection;
  status: string;
  summary: string;
}

/**
 * Client-side filter over the registry (`web-console` spec task 2.5). The registry is
 * passed in from the server page so the client bundle carries only the index rows.
 */
export function HelpIndex({ sections, entries }: { sections: HelpSectionMeta[]; entries: HelpIndexItem[] }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!needle) return entries;
    return entries.filter((entry) => {
      const section = sections.find((meta) => meta.id === entry.section)?.title ?? entry.section;
      return [entry.title, entry.summary, entry.status, section].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [entries, needle, sections]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="help-search" className="text-sm font-medium text-slate-700">
          Filter help
        </label>
        <input
          id="help-search"
          data-testid="help-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, section or summary"
          className="w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
        <span data-testid="help-result-count" className="text-xs text-slate-500">
          {filtered.length} of {entries.length} entries
        </span>
      </div>

      <div data-testid="help-index" className="space-y-6">
        {sections.map((section) => {
          const rows = filtered.filter((entry) => entry.section === section.id);
          if (rows.length === 0) return null;
          return (
            <section key={section.id} data-testid="help-section" data-section={section.id}>
              <h2 data-testid="help-section-title" className="text-sm font-semibold text-slate-900">
                {section.title}
              </h2>
              <p className="mt-1 max-w-prose text-xs text-slate-500">{section.description}</p>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {rows.map((entry) => (
                  <li key={entry.slug}>
                    <Link
                      href={`/help/${entry.slug}`}
                      data-testid="help-entry-link"
                      data-slug={entry.slug}
                      className="block rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300"
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900">{entry.title}</span>
                        <span className="shrink-0 text-[11px] text-slate-400">{entry.status}</span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-600">{entry.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {filtered.length === 0 ? (
          <p data-testid="help-no-results" className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
            No help entry matches “{query.trim()}”. Try a menu name (Gates, Secrets), a concept (canary) or a symptom
            (gate stuck).
          </p>
        ) : null}
      </div>
    </div>
  );
}
