export interface NavItem {
  href: string;
  label: string;
  testId: string;
  /** Optional icon name rendered by the Graphite Command sidebar. */
  icon?: string;
  /**
   * True for pages that live under a factory (`/factories/:id/...`). The href above is the
   * un-prefixed segment; the sidebar resolves it against the selected factory id.
   */
  factoryScoped?: boolean;
}

/** Top-level nav parity with the reference product (`ANALYSIS.md` §4.1). */
export const TOP_NAV: NavItem[] = [
  { href: '/chat', label: 'New Chat', testId: 'nav-chat', icon: 'chat' },
  { href: '/inbox', label: 'Inbox', testId: 'nav-inbox', icon: 'inbox' },
  { href: '/work-items', label: 'Work items', testId: 'nav-work-items', factoryScoped: true, icon: 'list' },
  { href: '/runs', label: 'Runs', testId: 'nav-runs', factoryScoped: true, icon: 'play' },
  { href: '/runners', label: 'Runners', testId: 'nav-runners', icon: 'server' },
  { href: '/secrets', label: 'Secrets', testId: 'nav-secrets', icon: 'key' },
  { href: '/users', label: 'Users', testId: 'nav-users', icon: 'users' },
];

/**
 * Footer links pinned above the account footer. `API` sits above `Help`: both open a help
 * entry, but the API reference is the one people reach for by name (ADR-030).
 */
export const FOOTER_NAV: NavItem[] = [
  { href: '/help/api', label: 'API', testId: 'nav-api', icon: 'code' },
];

export interface FactoryNavItem {
  segment: string;
  label: string;
  testId: string;
  /** Optional icon name rendered by the Graphite Command sidebar. */
  icon?: string;
}

/** Per-factory group; `Definition` and `Gates` are promoted to first-class pages. */
export const FACTORY_NAV: FactoryNavItem[] = [
  { segment: 'dashboard', label: 'Dashboard', testId: 'nav-dashboard', icon: 'dashboard' },
  { segment: 'missions', label: 'Missions', testId: 'nav-missions', icon: 'target' },
  { segment: 'readiness', label: 'Readiness', testId: 'nav-readiness', icon: 'gauge' },
  { segment: 'agents', label: 'Agents', testId: 'nav-agents', icon: 'users' },
  { segment: 'automations', label: 'Automations', testId: 'nav-automations', icon: 'zap' },
  { segment: 'scorers', label: 'Scorers', testId: 'nav-scorers', icon: 'star' },
  { segment: 'mcps', label: 'MCPs and apps', testId: 'nav-mcps', icon: 'plug' },
  { segment: 'self-improvement', label: 'Self-improvement', testId: 'nav-self-improvement', icon: 'trend' },
  { segment: 'benchmarks', label: 'Benchmarks', testId: 'nav-benchmarks', icon: 'bars' },
  { segment: 'definition', label: 'Definition', testId: 'nav-definition', icon: 'file' },
  { segment: 'gates', label: 'Gates', testId: 'nav-gates', icon: 'shield' },
  { segment: 'merge-queue', label: 'Merge queue', testId: 'nav-merge-queue', icon: 'merge' },
  { segment: 'settings', label: 'Settings', testId: 'nav-settings', icon: 'gear' },
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
