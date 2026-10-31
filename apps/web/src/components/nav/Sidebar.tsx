'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { FACTORY_NAV, TOP_NAV, factoryHref } from '@/lib/nav';
import type { FactoryListItem } from '@/lib/types';

function factoryFromPathname(pathname: string): string | null {
  const match = /^\/factories\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function Sidebar({ factories }: { factories: FactoryListItem[] }) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const activeFactory = factoryFromPathname(pathname) ?? factories[0]?.name ?? 'example';
  const activeFactoryEntry = factories.find((factory) => factory.name === activeFactory) ?? null;

  const isActive = (href: string): boolean =>
    pathname === href || (href !== '/chat' && pathname.startsWith(`${href}/`));

  return (
    <nav
      data-testid="nav-sidebar"
      aria-label="Main navigation"
      className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white"
    >
      <div className="border-b border-slate-200 px-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Software Factory</p>
        <label htmlFor="factory-switcher" className="mt-3 block text-xs font-medium text-slate-500">
          Factory
        </label>
        <select
          id="factory-switcher"
          data-testid="factory-switcher"
          value={activeFactory}
          onChange={(event) => router.push(factoryHref(event.target.value, 'dashboard'))}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
        >
          {factories.length === 0 ? <option value="example">example</option> : null}
          {factories.map((factory) => (
            <option key={factory.name} value={factory.name}>
              {factory.alias ? `${factory.alias} (${factory.name})` : factory.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {TOP_NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={item.testId}
                data-active={isActive(item.href) ? 'true' : 'false'}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`block rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 ${
                  isActive(item.href)
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex items-center justify-between px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Factories
          </span>
          <span aria-hidden="true" className="text-sm text-slate-400" title="Creating factories is not wired yet">
            +
          </span>
        </div>
        <p data-testid="nav-factory-name" className="px-3 text-sm font-medium text-slate-800">
          {activeFactoryEntry?.alias ?? activeFactory}
        </p>
        <ul className="mt-1 space-y-0.5">
          {FACTORY_NAV.map((item) => {
            const href = factoryHref(activeFactory, item.segment);
            return (
              <li key={item.segment}>
                <Link
                  href={href}
                  data-testid={item.testId}
                  data-active={pathname === href ? 'true' : 'false'}
                  aria-current={pathname === href ? 'page' : undefined}
                  className={`block rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 ${
                    pathname === href ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-slate-200 px-4 py-3">
        <div data-testid="nav-usage" className="flex items-center gap-2 text-xs text-slate-500">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-500" />
          Usage available
        </div>
        <div data-testid="nav-account" className="mt-2 text-sm text-slate-700">
          Local user <span className="text-slate-400">/</span> Engineering
        </div>
      </div>
    </nav>
  );
}
