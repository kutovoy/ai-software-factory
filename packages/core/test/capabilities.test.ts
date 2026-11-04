import { describe, expect, test } from 'bun:test';
import { selectCapabilities, type CapabilityEntry } from '../src/mcp/capabilities';

function entry(overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    server: 'github',
    tool: 'search_issues',
    description: 'Search GitHub issues and pull requests',
    schemaBytes: 400,
    status: 'discovered',
    ...overrides,
  };
}

describe('progressive capability selection', () => {
  test('selects capabilities matching the prompt', () => {
    const index = [
      entry(),
      entry({ server: 'slack', tool: 'post_message', description: 'Send a Slack message', schemaBytes: 300 }),
      entry({ server: 'docs', tool: 'search', description: 'Search documentation', schemaBytes: 200 }),
    ];
    const selection = selectCapabilities(index, 'search github issues', { limit: 1 });
    expect(selection.entries[0]?.server).toBe('github');
    expect(selection.selectedSchemaBytes).toBe(400);
    expect(selection.savingsRatio).toBeGreaterThan(0);
  });

  test('keeps one capability when nothing matches', () => {
    const selection = selectCapabilities([entry(), entry({ server: 'slack', tool: 'post' })], 'zzz');
    expect(selection.entries).toHaveLength(1);
    expect(selection.reason).toContain('no keyword match');
  });

  test('promoted capabilities rank higher', () => {
    const selection = selectCapabilities(
      [
        entry({ server: 'a', tool: 'x', description: 'search', schemaBytes: 100 }),
        entry({ server: 'b', tool: 'y', description: 'search', schemaBytes: 100, status: 'promoted' }),
      ],
      'search',
      { limit: 1 },
    );
    expect(selection.entries[0]?.server).toBe('b');
  });
});
