export interface NavItem {
  href: string;
  label: string;
  testId: string;
}

/** Top-level nav parity with the reference product (`ANALYSIS.md` §4.1). */
export const TOP_NAV: NavItem[] = [
  { href: '/chat', label: 'New Chat', testId: 'nav-chat' },
  { href: '/inbox', label: 'Inbox', testId: 'nav-inbox' },
  { href: '/work-items', label: 'Work items', testId: 'nav-work-items' },
  { href: '/runs', label: 'Runs', testId: 'nav-runs' },
  { href: '/mcps', label: 'MCPs and apps', testId: 'nav-mcps' },
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
  { segment: 'self-improvement', label: 'Self-improvement', testId: 'nav-self-improvement' },
  { segment: 'benchmarks', label: 'Benchmarks', testId: 'nav-benchmarks' },
  { segment: 'definition', label: 'Definition', testId: 'nav-definition' },
  { segment: 'gates', label: 'Gates', testId: 'nav-gates' },
  { segment: 'merge-queue', label: 'Merge queue', testId: 'nav-merge-queue' },
  { segment: 'settings', label: 'Settings', testId: 'nav-settings' },
];

export function factoryHref(factory: string, segment: string): string {
  return `/factories/${encodeURIComponent(factory)}/${segment}`;
}
