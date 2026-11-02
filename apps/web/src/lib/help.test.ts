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
import { FACTORY_NAV, FOOTER_NAV, TOP_NAV, helpHrefFor } from './nav';

/**
 * The help registry is a contract with the navigation (`web-console` spec: "Menu
 * reference" + "Help stays current"). If a nav item loses its entry, this fails before
 * a user finds a dead link.
 */
describe('help registry', () => {
  test('every top-level nav item has a menu entry pointing at its page', () => {
    for (const item of TOP_NAV) {
      const href = helpHrefFor(item);
      const entry = menuEntryForHref(href);
      expect(entry, `no help entry for ${item.label} (${href})`).toBeDefined();
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

  test('every footer nav item has a menu entry', () => {
    // Footer links point at help entries, so the slug is the href minus `/help/`.
    for (const item of FOOTER_NAV) {
      const slug = item.href.replace(/^\/help\//, '');
      const entry = getHelpEntry(slug);
      expect(entry, `no help entry for footer link ${item.label} (${item.href})`).toBeDefined();
      expect(entry?.title).toBe(item.label);
      expect(entry?.section).toBe('menu');
    }
    // The API entry is generated from the served OpenAPI document, not typed by hand.
    expect(getHelpEntry('api')?.renderer).toBe('api-reference');
  });

  test('supported projects states the unit of work and the out-of-scope list', () => {
    const entry = getHelpEntry('factories/supported-projects');
    expect(entry?.section).toBe('factories');
    const text = (entry?.blocks ?? [])
      .flatMap((block) => {
        if (block.kind === 'prose' || block.kind === 'callout') return [block.text];
        if (block.kind === 'list' || block.kind === 'checklist') return block.items;
        return [];
      })
      .join(' ');
    expect(text).toContain('repository diff verified by checks');
    expect(text).toContain('Terraform');
    expect(text.toLowerCase()).toContain('out of scope');
    expect(text).toContain('merge queue');
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

  test('the Users page describes shipped console auth, not a stub', () => {
    const users = getHelpEntry('users');
    expect(users?.status.toLowerCase()).toContain('shipped');
    expect(users?.summary.toLowerCase()).toContain('admin');
    expect(getHelpEntry('concepts/signing-in')?.section).toBe('concepts');
    expect(getHelpEntry('concepts/roles-and-scope')?.section).toBe('concepts');
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
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/work-items/wi_123')).toBe(
      'work-items',
    );
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/runs/run_123')).toBe('runs');
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/work-items')).toBe(
      'work-items',
    );
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/scores/score_123')).toBe(
      'runs',
    );
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/mcps')).toBe(
      'factories/mcps',
    );
    expect(helpSlugForPath('/secrets')).toBe('secrets');
    expect(helpSlugForPath('/users')).toBe('users');
  });

  test('factory pages map by segment, defaulting to dashboard', () => {
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/gates')).toBe(
      'factories/gates',
    );
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAW/self-improvement')).toBe(
      'factories/self-improvement',
    );
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('factories/dashboard');
  });

  test('the index and unknown routes fall back to /help', () => {
    expect(helpSlugForPath('/')).toBeNull();
    expect(helpSlugForPath('/help')).toBeNull();
    expect(helpSlugForPath('/help/quick-start')).toBeNull();
    expect(helpSlugForPath('/does-not-exist')).toBeNull();
    expect(helpSlugForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/unknown-page')).toBeNull();

    const known = helpContextForPath('/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/gates');
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
    for (const path of [
      '/chat',
      '/inbox',
      '/secrets',
      '/users',
      '/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/work-items',
      '/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/runs',
      '/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/scores/score_123',
      '/factories/fac_01ARZ3NDEKTSV4RRFFQ69G5FAV/mcps',
    ]) {
      const slug = helpSlugForPath(path);
      expect(slug, path).not.toBeNull();
      expect(getHelpEntry(slug as string), path).toBeDefined();
    }
    for (const item of FACTORY_NAV) {
      expect(getHelpEntry(`factories/${item.segment}`), item.segment).toBeDefined();
    }
  });
});
