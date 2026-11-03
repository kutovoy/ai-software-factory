'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NavIcon } from '@/components/nav/NavIcon';
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
  /** Local Forgejo is enabled (spec `forge`); the menu links to it in the factory group. */
  forgejoEnabled?: boolean;
  /** Signed-in user resolved by the root layout (`null` when auth is off). */
  user?: UserWire | null;
  /** `AUTH_REQUIRED=1`: show the account/sign-out block instead of the local-user label. */
  authRequired?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  /** Expanded by default; the toggle collapses the rail to an icon strip. */
  const [collapsed, setCollapsed] = useState(false);

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
  const factoryInitial = activeFactoryName.charAt(0).toUpperCase() || '–';
  const userInitials = (user?.name ?? user?.username ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase();

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

  const navItemClass = (active: boolean): string =>
    `flex items-center rounded-md text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-teal-400/40 ${
      collapsed ? 'justify-center px-0 py-1.5' : 'gap-2 px-3 py-1'
    } ${
      active
        ? 'bg-slate-800 font-medium text-slate-100 shadow-[inset_2px_0_0_0_#2dd4bf]'
        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
    }`;

  const labelClass = collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate';

  /**
   * Bounded, pinned column (`web-console` spec: "Pinned sidebar footer"): the sidebar is
   * `h-screen` and sticks to the top, so it never grows with the page. The nav list is the
   * only scrollable region, with its scrollbar hidden (`.sidebar-scroll`); the header and
   * account block stay visible on long pages such as the quick start.
   */
  return (
    <nav
      data-testid="nav-sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Main navigation"
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-slate-300 transition-[width] duration-200 ${
        collapsed ? 'w-20' : 'w-60'
      }`}
    >
      <div className={`shrink-0 border-b border-slate-800 ${collapsed ? 'px-2 py-3' : 'px-4 py-4'}`}>
        <div className={`flex items-center gap-2 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-teal-400 text-[10px] font-black tracking-tight text-slate-950">
              SF
            </span>
            {!collapsed ? (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold tracking-tight text-slate-100">
                  Software Factory
                </p>
                <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">control plane</p>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="nav-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
          >
            <NavIcon name={collapsed ? 'chevron-right' : 'chevron-left'} className="h-4 w-4" />
          </button>
        </div>

        {!collapsed ? (
          <>
            <label
              htmlFor="factory-switcher"
              className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500"
            >
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
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 focus:border-teal-400 focus:outline-none focus:ring-2 focus:ring-teal-400/20"
            >
              {factories.length === 0 ? <option value="">No factories</option> : null}
              {factories.map((factory) => (
                <option key={factoryValue(factory)} value={factoryValue(factory)}>
                  {factoryOptionLabel(factory)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title={`Factory: ${activeFactoryName} — expand to switch`}
            aria-label={`Factory: ${activeFactoryName}. Expand sidebar to switch.`}
            className="mt-3 flex h-9 w-full items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
          >
            {factoryInitial}
          </button>
        )}
      </div>

      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {!collapsed ? (
          <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Workspace
          </p>
        ) : null}
        <ul className="space-y-0.5">
          {TOP_NAV.map((item) => {
            const href = navHref(item, activeFactoryId);
            const active = isActive(href);
            return (
              <li key={item.href}>
                {item.factoryScoped && !activeFactoryId ? (
                  <span
                    data-testid={item.testId}
                    data-active="false"
                    title={collapsed ? item.label : 'Add a factory to use this page'}
                    className={`flex items-center rounded-md text-[13px] text-slate-600 ${
                      collapsed ? 'justify-center px-0 py-1.5' : 'gap-2 px-3 py-1'
                    }`}
                  >
                    <NavIcon name={item.icon} className="h-4 w-4 shrink-0 opacity-50" />
                    <span className={labelClass}>{item.label}</span>
                  </span>
                ) : (
                  <Link
                    href={href}
                    data-testid={item.testId}
                    data-active={active ? 'true' : 'false'}
                    aria-current={active ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                    className={navItemClass(active)}
                  >
                    <NavIcon name={item.icon} className="h-4 w-4 shrink-0 opacity-80" />
                    <span className={labelClass}>{item.label}</span>
                  </Link>
                )}
              </li>
            );
          })}
          {FOOTER_NAV.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                data-testid={item.testId}
                data-active={pathname === item.href ? 'true' : 'false'}
                aria-current={pathname === item.href ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
                className={navItemClass(pathname === item.href)}
              >
                <NavIcon name={item.icon} className="h-4 w-4 shrink-0 opacity-80" />
                <span className={labelClass}>{item.label}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link
              href="/help"
              data-testid="nav-help"
              data-active={isHelpActive ? 'true' : 'false'}
              aria-current={isHelpActive ? 'page' : undefined}
              title={collapsed ? 'Help' : undefined}
              className={navItemClass(isHelpActive)}
            >
              <NavIcon name="help" className="h-4 w-4 shrink-0 opacity-80" />
              <span className={labelClass}>Help</span>
            </Link>
          </li>
        </ul>

        {!collapsed ? (
          <>
            <div className="mt-4 flex items-center justify-between px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Factories
              </span>
              <Link
                href="/help/factories/add"
                data-testid="nav-add-factory"
                aria-label="Add a factory (git-backed)"
                title="Add a factory (git-backed)"
                className="flex h-5 w-5 items-center justify-center rounded-full text-sm leading-none text-slate-500 hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-400/40"
              >
                <span aria-hidden="true">+</span>
              </Link>
            </div>
            <p data-testid="nav-factory-name" className="px-3 text-sm font-medium text-slate-200">
              {activeFactoryName}
            </p>
          </>
        ) : null}
        <ul className={collapsed ? 'mt-1 space-y-0.5' : 'mt-1 space-y-0.5'}>
          {FACTORY_NAV.map((item) => {
            if (!activeFactoryId) return null;
            const href = factoryHref(activeFactoryId, item.segment);
            const active = pathname === href;
            return (
              <li key={item.segment}>
                <Link
                  href={href}
                  data-testid={item.testId}
                  data-active={active ? 'true' : 'false'}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  className={navItemClass(active)}
                >
                  <NavIcon name={item.icon} className="h-4 w-4 shrink-0 opacity-80" />
                  <span className={labelClass}>{item.label}</span>
                </Link>
              </li>
            );
          })}
          {forgejoEnabled && activeFactoryId ? (
            <li>
              <a
                href="/extras/forgejo/"
                target="_blank"
                rel="noreferrer"
                data-testid="nav-forgejo"
                title={collapsed ? 'Forgejo' : undefined}
                className={navItemClass(false)}
              >
                <span className={labelClass}>Forgejo</span>
                <span className="text-slate-600" aria-hidden="true">
                  ↗
                </span>
              </a>
            </li>
          ) : null}
        </ul>
      </div>

      <div className={`shrink-0 border-t border-slate-800 ${collapsed ? 'px-2 py-3' : 'px-3 py-3'}`}>
        <div
          data-testid="nav-account"
          className={`text-sm text-slate-300 ${collapsed ? 'flex flex-col items-center gap-2' : ''}`}
        >
          {authRequired ? (
            user ? (
              collapsed ? (
                <span
                  title={user.name ?? user.username}
                  className="grid h-8 w-8 place-items-center rounded-full bg-teal-400/10 text-xs font-semibold text-teal-300 ring-1 ring-teal-400/30"
                >
                  {userInitials}
                </span>
              ) : (
                <div className="space-y-1">
                  <p data-testid="nav-user-name" className="truncate font-medium text-slate-100">
                    {user.name ?? user.username}
                  </p>
                  <p data-testid="nav-user-email" className="truncate text-xs text-slate-500">
                    {user.email}
                  </p>
                  <span
                    data-testid="nav-user-role"
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      user.role === 'admin'
                        ? 'bg-teal-400/10 text-teal-300 ring-teal-400/30'
                        : 'bg-slate-800 text-slate-300 ring-slate-700'
                    }`}
                  >
                    {user.role}
                  </span>
                </div>
              )
            ) : (
              <div className={`space-y-1 ${collapsed ? 'text-center' : ''}`}>
                <p data-testid="nav-user-name" className="font-medium text-slate-200">
                  {collapsed ? '?' : 'Not signed in'}
                </p>
                {!collapsed ? (
                  <Link
                    href={`/login?next=${encodeURIComponent(pathname)}`}
                    data-testid="nav-signin"
                    className="text-xs font-medium text-teal-300 underline hover:text-teal-200"
                  >
                    Sign in
                  </Link>
                ) : null}
              </div>
            )
          ) : (
            <span data-testid="nav-local-user" className={`text-slate-400 ${collapsed ? 'sr-only' : ''}`}>
              Local user <span className="text-slate-600">/</span> auth off
            </span>
          )}
        </div>
        <div className={`mt-2 flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
          {authRequired && user && !collapsed ? (
            <button
              type="button"
              data-testid="nav-signout"
              onClick={() => void signOut()}
              disabled={signingOut}
              className="min-w-0 flex-1 rounded-md border border-slate-700 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400/40 disabled:opacity-60"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          ) : null}
          <a
            href="https://github.com/kutovoy/ai-software-factory/"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="nav-github"
            aria-label="Software Factory on GitHub"
            title="Software Factory on GitHub"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-400/40 ${
              collapsed ? 'mx-auto' : 'ml-auto'
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-4 w-4 fill-current"
              focusable="false"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
      </div>
    </nav>
  );
}
