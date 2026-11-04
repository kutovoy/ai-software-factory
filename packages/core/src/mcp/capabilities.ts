import type { FactoryDefinition } from '../loader/load';
import { declaredMcpServers } from '../secrets/references';

/**
 * Progressive context / capability discovery (roadmap item 9).
 *
 * The definition declares MCP servers; discovered tool metadata is persisted by the API.
 * A deterministic keyword scorer selects the capabilities relevant to a task prompt so the
 * harness receives a smaller context instead of every server schema. The full index remains
 * available for operators and for promotion.
 */

export interface CapabilityEntry {
  server: string;
  /** `null` for a server-level capability (no discovered tool metadata yet). */
  tool: string | null;
  description: string | null;
  /** Approximate serialized schema size, used for token-savings accounting. */
  schemaBytes: number;
  status: 'declared' | 'discovered' | 'promoted';
}

export interface CapabilitySelection {
  entries: CapabilityEntry[];
  fullSchemaBytes: number;
  selectedSchemaBytes: number;
  /** 0–1; `0` when there is no schema to save. */
  savingsRatio: number;
  reason: string;
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'build',
  'create',
  'make',
  'add',
  'fix',
  'use',
  'into',
  'site',
  'task',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

export function scoreCapability(entry: CapabilityEntry, prompt: string): number {
  const words = new Set(tokens(prompt));
  const haystack = `${entry.server} ${entry.tool ?? ''} ${entry.description ?? ''}`.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (haystack.includes(word)) score += 1;
  }
  if (entry.status === 'promoted') score += 2;
  return score;
}

export function buildCapabilityIndex(
  definition: FactoryDefinition,
  discovered: Array<{
    server: string;
    tool: string;
    description: string | null;
    schemaBytes: number;
    status: 'discovered' | 'promoted';
  }> = [],
): CapabilityEntry[] {
  const declared = declaredMcpServers(definition.manifest);
  const entries: CapabilityEntry[] = declared.map((server) => ({
    server: server.name,
    tool: null,
    description: server.description ?? null,
    schemaBytes: JSON.stringify(server).length,
    status: 'declared',
  }));
  for (const item of discovered) {
    entries.push({
      server: item.server,
      tool: item.tool,
      description: item.description,
      schemaBytes: item.schemaBytes,
      status: item.status,
    });
  }
  return entries.sort((left, right) =>
    `${left.server}/${left.tool ?? ''}`.localeCompare(`${right.server}/${right.tool ?? ''}`),
  );
}

export function selectCapabilities(
  index: CapabilityEntry[],
  prompt: string,
  options: { limit?: number } = {},
): CapabilitySelection {
  const fullSchemaBytes = index.reduce((sum, entry) => sum + entry.schemaBytes, 0);
  if (index.length === 0) {
    return {
      entries: [],
      fullSchemaBytes: 0,
      selectedSchemaBytes: 0,
      savingsRatio: 0,
      reason: 'no capabilities declared',
    };
  }

  const scored = index
    .map((entry) => ({ entry, score: scoreCapability(entry, prompt) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.server.localeCompare(right.entry.server));

  const limit = Math.max(1, options.limit ?? 5);
  // No keyword match is not a reason to starve the agent: keep the highest-value declared
  // server so the run still has a capability, but record that discovery found no match.
  const selected =
    scored.length > 0
      ? scored.slice(0, limit).map((item) => item.entry)
      : [index.find((entry) => entry.status === 'promoted') ?? index[0]!];

  const selectedSchemaBytes = selected.reduce((sum, entry) => sum + entry.schemaBytes, 0);
  return {
    entries: selected,
    fullSchemaBytes,
    selectedSchemaBytes,
    savingsRatio:
      fullSchemaBytes === 0 ? 0 : Math.round((1 - selectedSchemaBytes / fullSchemaBytes) * 1000) / 1000,
    reason:
      scored.length > 0
        ? `matched ${scored.length} capability/ies; selected ${selected.length}`
        : 'no keyword match; kept one declared capability',
  };
}
