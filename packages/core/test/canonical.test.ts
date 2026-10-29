import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrThrow, serializeDefinition } from '../src/index';
import { EXAMPLE } from './helpers';

interface Golden {
  files: Array<{ path: string; content: string }>;
}

describe('canonical snapshot', () => {
  const golden = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/canonical-example.json'), 'utf8'),
  ) as Golden;

  it('matches the checked-in canonical output for factories/example', () => {
    const files = serializeDefinition(loadOrThrow(EXAMPLE));
    expect({ files }).toEqual(golden);
  });

  it('writes sorted YAML keys with two-space indentation and a trailing newline', () => {
    const files = serializeDefinition(loadOrThrow(EXAMPLE));
    const manifest = files.find((file) => file.path === 'factory.yaml');
    expect(manifest).toBeDefined();
    if (!manifest) return;

    expect(manifest.content.endsWith('\n')).toBe(true);
    expect(manifest.content).not.toContain('\t');

    const topLevelKeys = manifest.content
      .split('\n')
      .filter((line) => /^[a-zA-Z]/.test(line))
      .map((line) => line.slice(0, line.indexOf(':')));
    expect(topLevelKeys).toEqual([...topLevelKeys].sort());

    expect(manifest.content).toContain('\n  harness:\n    model: openai/gpt-5\n    type: opencode\n');
  });

  it('preserves Markdown frontmatter delimiters and bodies', () => {
    const files = serializeDefinition(loadOrThrow(EXAMPLE));
    const agent = files.find((file) => file.path === 'agents/foreman/agent.md');
    expect(agent).toBeDefined();
    if (!agent) return;
    expect(agent.content.startsWith('---\n')).toBe(true);
    expect(agent.content).toContain('\n---\n\n# Foreman\n');
    expect(agent.content.endsWith('\n')).toBe(true);
  });
});
