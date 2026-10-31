import { describe, expect, test } from 'bun:test';
import {
  HELP_ENTRIES,
  HELP_SECTIONS,
  helpContextForPath,
  helpSlugForPath,
  getHelpEntry,
  menuEntryForFactorySegment,
  menuEntryForHref,
} from './help';
import { FACTORY_NAV, TOP_NAV } from './nav';

/**
 * The help registry is a contract with the navigation (`web-console` spec: "Menu
 * reference" + "Help stays current"). If a nav item loses its entry, this fails before
 * a user finds a dead link.
 */
describe('help registry', () => {
  test('every top-level nav item has a menu entry pointing at its page', () => {
    for (const item of TOP_NAV) {
      const entry = menuEntryForHref(item.href);
      expect(entry, `no help entry for ${item.label} (${item.href})`).toBeDefined();
      expect(entry?.title).toBe(item.label);
      expect(entry?.section).toBe('menu');
    }
  });

  test('every factory nav item has a menu entry', () => {
    for (const item of FACTORY_NAV) {
      const entry = menuEntryForFactorySegment(item.segment);
      expect(entry, `no help entry for factory segment ${item.segment}`).toBeDefined();
      expect(entry?.title).toBe(item.label);
      expect(entry?.section).toBe('menu');
      expect(entry?.pageHref).toBe(`/factories/example/${item.segment}`);
    }
  });

  test('slugs are unique and every section has content', () => {
    const slugs = HELP_ENTRIES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const section of HELP_SECTIONS) {
      expect(HELP_ENTRIES.filter((entry) => entry.section === section.id).length).toBeGreaterThan(0);
    }
  });

  test('every entry is honest and complete', () => {
    for (const entry of HELP_ENTRIES) {
      expect(entry.title.trim().length, entry.slug).toBeGreaterThan(0);
      expect(entry.summary.trim().length, entry.slug).toBeGreaterThan(0);
      expect(entry.status.trim().length, entry.slug).toBeGreaterThan(0);
      expect(entry.blocks.length, entry.slug).toBeGreaterThan(0);
      expect(entry.related.length, entry.slug).toBeGreaterThan(0);
      for (const link of entry.related) {
        expect(link.href.startsWith('/'), `${entry.slug} → ${link.href}`).toBe(true);
      }
    }
  });

  test('the Users page is described as a stub, not as shipped', () => {
    const users = getHelpEntry('users');
    expect(users?.status.toLowerCase()).toContain('stub');
    expect(users?.summary.toLowerCase()).toContain('phase 6');
  });

  test('the quick start carries the three diagrams and a success checklist', () => {
    const quickStart = getHelpEntry('quick-start');
    expect(quickStart?.section).toBe('quick-start');
    const diagrams = (quickStart?.blocks ?? []).flatMap((block) => (block.kind === 'diagram' ? [block.name] : []));
    expect(diagrams.sort()).toEqual(['anatomy', 'gates', 'pipeline']);
    expect((quickStart?.blocks ?? []).some((block) => block.kind === 'checklist')).toBe(true);
  });
});

describe('contextual help routing', () => {
  test('known pages map to their entry', () => {
    expect(helpSlugForPath('/chat')).toBe('chat');
    expect(helpSlugForPath('/inbox')).toBe('inbox');
    expect(helpSlugForPath('/work-items/wi_123')).toBe('work-items');
    expect(helpSlugForPath('/runs/run_123')).toBe('runs');
    expect(helpSlugForPath('/scores/score_123')).toBe('runs');
    expect(helpSlugForPath('/mcps')).toBe('mcps');
    expect(helpSlugForPath('/secrets')).toBe('secrets');
    expect(helpSlugForPath('/users')).toBe('users');
  });

  test('factory pages map by segment, defaulting to dashboard', () => {
    expect(helpSlugForPath('/factories/example/gates')).toBe('factories/gates');
    expect(helpSlugForPath('/factories/example-lights-off/self-improvement')).toBe(
      'factories/self-improvement',
    );
    expect(helpSlugForPath('/factories/example')).toBe('factories/dashboard');
  });

  test('the index and unknown routes fall back to /help', () => {
    expect(helpSlugForPath('/')).toBeNull();
    expect(helpSlugForPath('/help')).toBeNull();
    expect(helpSlugForPath('/help/quick-start')).toBeNull();
    expect(helpSlugForPath('/does-not-exist')).toBeNull();
    expect(helpSlugForPath('/factories/example/unknown-page')).toBeNull();

    const known = helpContextForPath('/factories/example/gates');
    expect(known.href).toBe('/help/factories/gates');
    expect(known.pageName).toBe('Gates');

    const chat = helpContextForPath('/chat');
    expect(chat.href).toBe('/help/chat');
    expect(chat.pageName).toBe('New Chat');

    const unknown = helpContextForPath('/does-not-exist');
    expect(unknown.href).toBe('/help');
    expect(unknown.slug).toBeNull();
    expect(unknown.pageName).toBe('this page');
  });

  test('every mapped slug resolves to a real entry', () => {
    for (const path of ['/chat', '/inbox', '/work-items', '/runs', '/scores', '/mcps', '/secrets', '/users']) {
      const slug = helpSlugForPath(path);
      expect(slug, path).not.toBeNull();
      expect(getHelpEntry(slug as string), path).toBeDefined();
    }
    for (const item of FACTORY_NAV) {
      expect(getHelpEntry(`factories/${item.segment}`), item.segment).toBeDefined();
    }
  });
});
