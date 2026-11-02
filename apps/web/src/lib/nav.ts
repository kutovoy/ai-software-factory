export interface NavItem {
  href: string;
  label: string;
  testId: string;
  /**
   * True for pages that live under a factory (`/factories/:id/...`). The href above is the
   * un-prefixed segment; the sidebar resolves it against the selected factory id.
   */
  factoryScoped?: boolean;
}

/** Top-level nav parity with the reference product (`ANALYSIS.md` §4.1). */
export const TOP_NAV: NavItem[] = [
  { href: '/chat', label: 'New Chat', testId: 'nav-chat' },
  { href: '/inbox', label: 'Inbox', testId: 'nav-inbox' },
  { href: '/work-items', label: 'Work items', testId: 'nav-work-items', factoryScoped: true },
  { href: '/runs', label: 'Runs', testId: 'nav-runs', factoryScoped: true },
  { href: '/secrets', label: 'Secrets', testId: 'nav-secrets' },
  { href: '/users', label: 'Users', testId: 'nav-users' },
];

/**
 * Footer links pinned above the account footer. `API` sits above `Help`: both open a help
 * entry, but the API reference is the one people reach for by name (ADR-030).
 */
export const FOOTER_NAV: NavItem[] = [{ href: '/help/api', label: 'API', testId: 'nav-api' }];

export interface FactoryNavItem {
  segment: string;
  label: string;
  testId: string;
}

/** Per-factory group; `Definition` and `Gates` are promoted to first-class pages. */
export const FACTORY_NAV: FactoryNavItem[] = [
  { segment: 'dashboard', label: 'Dashboard', testId: 'nav-dashboard' },
  { segment: 'agents', label: 'Agents', testId: 'nav-agents' },
  { segment: 'automations', label: 'Automations', testId: 'nav-automations' },
  { segment: 'scorers', label: 'Scorers', testId: 'nav-scorers' },
  { segment: 'mcps', label: 'MCPs and apps', testId: 'nav-mcps' },
  { segment: 'self-improvement', label: 'Self-improvement', testId: 'nav-self-improvement' },
  { segment: 'benchmarks', label: 'Benchmarks', testId: 'nav-benchmarks' },
  { segment: 'definition', label: 'Definition', testId: 'nav-definition' },
  { segment: 'gates', label: 'Gates', testId: 'nav-gates' },
  { segment: 'merge-queue', label: 'Merge queue', testId: 'nav-merge-queue' },
  { segment: 'settings', label: 'Settings', testId: 'nav-settings' },
];

/**
 * A factory page URL. `factoryId` is the committed `fac_<ulid>` id — never a directory
 * name (change `add-factory-identity`, spec `factory-identity`).
 */
export function factoryHref(factoryId: string, segment: string): string {
  return `/factories/${encodeURIComponent(factoryId)}/${segment}`;
}

/** The href the sidebar renders for a top-level item under the selected factory. */
export function navHref(item: NavItem, factoryId: string | null): string {
  if (!item.factoryScoped) return item.href;
  return factoryId ? factoryHref(factoryId, item.href.replace(/^\//, '')) : item.href;
}

/**
 * The illustrative href used by help/menu entries and their tests. Factory URLs need a
 * real id at render time; the help pages rewrite this prefix to the selected factory.
 */
export function helpHrefFor(item: NavItem): string {
  return item.factoryScoped
    ? `/factories/example/${item.href.replace(/^\//, '')}`
    : item.href;
}

/** True when a pathname is a factory-scoped page (`/factories/<id>/...`). */
export function isFactoryPath(pathname: string): boolean {
  return /^\/factories\/[^/]+/.test(pathname);
}
