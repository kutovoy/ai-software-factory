import { describe, expect, it } from 'bun:test';
import { diffDefinitions, loadOrThrow, renderDiffText, type Resource } from '../src/index';
import { EXAMPLE, LIGHTS_OFF } from './helpers';

describe('semantic diff', () => {
  it('reports a field change with a JSON pointer and both values', () => {
    const before = loadOrThrow(EXAMPLE);
    const after = structuredClone(before);
    const review = after.resources.find(
      (resource) => resource.kind === 'agent' && resource.name === 'review',
    ) as Resource;
    (review.doc as { harness: { model: string } }).harness.model = 'openai/gpt-5-mini';

    const diff = diffDefinitions(before, after);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].kind).toBe('agent');
    expect(diff.changed[0].name).toBe('review');
    expect(diff.changed[0].changes).toEqual([
      {
        pointer: '/harness/model',
        old: 'anthropic/claude-sonnet-4-5',
        new: 'openai/gpt-5-mini',
      },
    ]);
    expect(diff.isEmpty).toBe(false);
  });

  it('reports a removed resource', () => {
    const before = loadOrThrow(EXAMPLE);
    const after = structuredClone(before);
    after.resources = after.resources.filter(
      (resource) => !(resource.kind === 'scorer' && resource.name === 'scope'),
    );

    const diff = diffDefinitions(before, after);
    expect(diff.removed).toEqual([{ kind: 'scorer', name: 'scope' }]);
    expect(diff.isEmpty).toBe(false);
  });

  it('reports an added resource', () => {
    const before = loadOrThrow(EXAMPLE);
    const after = structuredClone(before);
    after.resources.push({
      kind: 'runner',
      name: 'extra',
      path: 'runners/extra.yaml',
      format: 'yaml',
      doc: { description: 'Extra runner.' },
      body: '',
    });

    const diff = diffDefinitions(before, after);
    expect(diff.added).toEqual([{ kind: 'runner', name: 'extra' }]);
  });

  it('reports body changes', () => {
    const before = loadOrThrow(EXAMPLE);
    const after = structuredClone(before);
    const skill = after.resources.find(
      (resource) => resource.kind === 'skill' && resource.name === 'conventions',
    ) as Resource;
    skill.body = `${skill.body}\n- New rule.\n`;

    const diff = diffDefinitions(before, after);
    expect(diff.changed[0].kind).toBe('skill');
    expect(diff.changed[0].changes[0].pointer).toBe('/body');
  });

  it('is empty for identical trees', () => {
    const diff = diffDefinitions(loadOrThrow(EXAMPLE), loadOrThrow(EXAMPLE));
    expect(diff.isEmpty).toBe(true);
    expect(renderDiffText(diff)).toBe('');
  });

  it('reports gates, mergePolicy and improvement authority between the two reference factories', () => {
    const diff = diffDefinitions(loadOrThrow(EXAMPLE), loadOrThrow(LIGHTS_OFF));
    // `example` also declares the nightly schedule automation, which `example-lights-off`
    // does not, and binds its `implement` agent to the `github` MCP server.
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([{ kind: 'automation', name: 'nightly' }]);
    expect(diff.changed.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      'agent:implement',
      'factory:example',
    ]);

    const factory = diff.changed.find((entry) => entry.kind === 'factory');
    expect(factory).toBeDefined();
    const pointers = factory?.changes.map((change) => change.pointer);
    expect(pointers).toEqual([
      '/gates/plan',
      '/gates/pr_review',
      '/gates/spec',
      '/improvement/authority',
      '/improvement/canaryPercent',
      '/improvement/rollbackThreshold',
      // `example` declares `mcp.servers`; `example-lights-off` still uses the legacy
      // `mcpServers` map, so the MCP block differs (change `add-secrets-and-mcp`).
      '/mcp',
      '/mcpServers',
      '/mergePolicy',
    ]);

    const implement = diff.changed.find((entry) => entry.kind === 'agent');
    expect(implement?.changes.map((change) => change.pointer)).toEqual(['/mcp']);

    const text = renderDiffText(diff);
    expect(text).toContain('~ factory:example /mergePolicy: "human" -> "auto_on_green"');
    expect(text).toContain('~ factory:example /improvement/authority: "propose_only" -> "canary"');
  });
});
