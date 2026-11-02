'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { FACTORY_NAV, FOOTER_NAV, TOP_NAV, factoryHref, navHref } from '@/lib/nav';
import type { FactoryListItem, UserWire } from '@/lib/types';

const FACTORY_COOKIE = 'factory';

function factoryFromPathname(pathname: string): string | null {
  const match = /^\/factories\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function persistFactory(id: string): void {
  document.cookie = `${FACTORY_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
}

/** The switcher value for a factory: its stable id (a URL may never carry the name). */
function factoryValue(factory: FactoryListItem): string {
  return factory.id ?? factory.key;
}

/** `alias (name)` for the switcher; the sidebar label is the alias or the directory name. */
function factoryOptionLabel(factory: FactoryListItem): string {
  const label = factory.alias?.trim() ? factory.alias : factory.name;
  return label === factory.name ? label : `${label} (${factory.name})`;
}

export function Sidebar({
  factories,
  initialFactory = null,
  forgejoEnabled = false,
  user = null,
  authRequired = false,
}: {
  factories: FactoryListItem[];
  /** Value of the `factory` cookie (a factory id), resolved by the root layout. */
  initialFactory?: string | null;
  /** Local Forgejo is enabled (spec `forge`); the menu links to it under "MCPs and apps". */
  forgejoEnabled?: boolean;
  /** Signed-in user resolved by the root layout (`null` when auth is off). */
  user?: UserWire | null;
  /** `AUTH_REQUIRED=1`: show the account/sign-out block instead of the local-user label. */
  authRequired?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  /**
   * Stable selection (`web-console` spec: "Stable factory selection"): the path wins on
   * `/factories/:id/*`; otherwise the persisted factory id holds, so clicking Runs/Inbox
   * never silently switches factory. `selected` starts `null` so the server and client
   * agree on the first render, then tracks the path and the switcher. The persisted value
   * is the factory **id**, not a directory name (change `add-factory-identity`).
   */
  const pathFactory = factoryFromPathname(pathname);
  const [selected, setSelected] = useState<string | null>(null);
  const known = (id: string | null): string | null =>
    id && factories.some((factory) => factoryValue(factory) === id) ? id : null;
  const activeFactoryId =
    pathFactory ?? selected ?? known(initialFactory) ?? (factories[0] ? factoryValue(factories[0]) : null);
  const activeFactoryEntry =
    factories.find((factory) => factoryValue(factory) === activeFactoryId) ?? null;
  const activeFactoryName = activeFactoryEntry
    ? activeFactoryEntry.alias?.trim() || activeFactoryEntry.name
    : 'no factory';

  // Opening a factory route makes that factory the persisted selection.
  useEffect(() => {
    if (!pathFactory) return;
    setSelected(pathFactory);
    persistFactory(pathFactory);
  }, [pathFactory]);

  const isActive = (href: string): boolean =>
    pathname === href || (href !== '/chat' && pathname.startsWith(`${href}/`));

  // `API` and `Help` share the /help prefix; only the one you are on is highlighted.
  const isHelpActive =
    pathname === '/help' || (pathname.startsWith('/help/') && pathname !== '/help/api');

  /**
   * Bounded, pinned column (`web-console` spec: "Pinned sidebar footer"): the sidebar is
   * `h-screen` and sticks to the top, so it never grows with the page. Only the nav list
   * scrolls (`min-h-0 overflow-y-auto`); the header, footer links and usage/account block
   * stay visible on long pages such as the quick start.
   */
  return (
    <nav
      data-testid="nav-sidebar"
      aria-label="Main navigation"
      className="sticky top-0 flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white"
    >
      <div className="shrink-0 border-b border-slate-200 px-4 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Software Factory</p>
        <label htmlFor="factory-switcher" className="mt-3 block text-xs font-medium text-slate-500">
          Factory
        </label>
        <select
          id="factory-switcher"
          data-testid="factory-switcher"
          value={activeFactoryId ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            setSelected(next);
            persistFactory(next);
            router.push(factoryHref(next, 'dashboard'));
          }}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
        >
          {factories.length === 0 ? <option value="">No factories</option> : null}
          {factories.map((factory) => (
            <option key={factoryValue(factory)} value={factoryValue(factory)}>
              {factoryOptionLabel(factory)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ul className="space-y-0.5">
          {TOP_NAV.map((item) => {
            const href = navHref(item, activeFactoryId);
            const active = isActive(href);
            return (
            <Fragment key={item.href}>
              <li>
                {item.factoryScoped && !activeFactoryId ? (
                  <span
                    data-testid={item.testId}
                    data-active="false"
                    title="Add a factory to use this page"
                    className="block rounded-md px-3 py-1.5 text-sm text-slate-400"
                  >
                    {item.label}
                  </span>
                ) : (
                  <Link
                    href={href}
                    data-testid={item.testId}
                    data-active={active ? 'true' : 'false'}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {item.label}
                  </Link>
                )}
              </li>
              {item.href === '/mcps' && forgejoEnabled ? (
                <li>
                  <a
                    href="/extras/forgejo/"
                    target="_blank"
                    rel="noreferrer"
                    data-testid="nav-forgejo"
                    className="block rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
                  >
                    Forgejo <span className="text-slate-400">↗</span>
                  </a>
                </li>
              ) : null}
            </Fragment>
            );
          })}
        </ul>

        <div className="mt-5 flex items-center justify-between px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Factories
          </span>
          <Link
            href="/help/factories/add"
            data-testid="nav-add-factory"
            aria-label="Add a factory (git-backed)"
            title="Add a factory (git-backed)"
            className="flex h-5 w-5 items-center justify-center rounded-full text-sm leading-none text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-300"
          >
            <span aria-hidden="true">+</span>
          </Link>
        </div>
        <p data-testid="nav-factory-name" className="px-3 text-sm font-medium text-slate-800">
          {activeFactoryName}
        </p>
        <ul className="mt-1 space-y-0.5">
          {FACTORY_NAV.map((item) => {
            if (!activeFactoryId) return null;
            const href = factoryHref(activeFactoryId, item.segment);
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

      <div className="shrink-0 border-t border-slate-200 px-2 py-2">
        {FOOTER_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testId}
            data-active={pathname === item.href ? 'true' : 'false'}
            aria-current={pathname === item.href ? 'page' : undefined}
            className={`mb-0.5 block rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 ${
              pathname === item.href
                ? 'bg-slate-900 text-white'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            {item.label}
          </Link>
        ))}
        <Link
          href="/help"
          data-testid="nav-help"
          data-active={isHelpActive ? 'true' : 'false'}
          aria-current={isHelpActive ? 'page' : undefined}
          className={`block rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 ${
            isHelpActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
          }`}
        >
          Help
        </Link>
      </div>

      <div className="shrink-0 border-t border-slate-200 px-4 py-3">
        <div data-testid="nav-usage" className="flex items-center gap-2 text-xs text-slate-500">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-500" />
          Usage available
        </div>
        <div data-testid="nav-account" className="mt-2 text-sm text-slate-700">
          {authRequired ? (
            user ? (
              <div className="space-y-1">
                <p data-testid="nav-user-name" className="truncate font-medium text-slate-800">
                  {user.name ?? user.username}
                </p>
                <p data-testid="nav-user-email" className="truncate text-xs text-slate-500">
                  {user.email}
                </p>
                <Badge tone={user.role === 'admin' ? 'info' : 'neutral'} testId="nav-user-role">
                  {user.role}
                </Badge>
              </div>
            ) : (
              <div className="space-y-1">
                <p data-testid="nav-user-name" className="font-medium text-slate-800">
                  Not signed in
                </p>
                <Link
                  href={`/login?next=${encodeURIComponent(pathname)}`}
                  data-testid="nav-signin"
                  className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
                >
                  Sign in
                </Link>
              </div>
            )
          ) : (
            <span data-testid="nav-local-user">
              Local user <span className="text-slate-400">/</span> auth off
            </span>
          )}
        </div>
        {authRequired && user ? (
          <button
            type="button"
            data-testid="nav-signout"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="mt-2 w-full rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-60"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        ) : null}
      </div>
    </nav>
  );
}
