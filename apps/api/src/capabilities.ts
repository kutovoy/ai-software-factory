import { z } from 'zod';
import {
  buildCapabilityIndex,
  declaredMcpServers,
  listMcpTools,
  loadDefinition,
  promoteMcpTool,
  selectCapabilities,
  upsertMcpTool,
  type CapabilityEntry,
  type FactoryDefinition,
} from '@factory/core';
import { getSql } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { ApiError, definitionInvalid, invalidRequest } from './errors';
import { resolveFactoryDir } from './factories';

/**
 * Progressive context / MCP capability index (roadmap item 9).
 *
 * The definition declares servers; discovered tool metadata is indexed in `mcp_tools`.
 * Selection is deterministic and keyword-based, and reports full vs selected schema bytes so
 * token savings are visible. Discovery and promotion are explicit operator actions.
 */

export const discoverBodySchema = z
  .object({
    server: z.string().min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(2000).optional(),
            schema: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type DiscoverBody = z.infer<typeof discoverBodySchema>;

function loadFactory(config: ApiConfig, factory: string): FactoryDefinition {
  const dir = resolveFactoryDir(config, factory);
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);
  return definition;
}

export interface CapabilityView {
  factory: string;
  declaredServers: string[];
  capabilities: CapabilityEntry[];
  selection: {
    entries: CapabilityEntry[];
    fullSchemaBytes: number;
    selectedSchemaBytes: number;
    savingsRatio: number;
    reason: string;
  } | null;
}

export async function getCapabilitiesForApi(
  config: ApiConfig,
  factory: string,
  query: string | null,
): Promise<CapabilityView> {
  const definition = loadFactory(config, factory);
  const discovered = (await listMcpTools(getSql(), factory)).map((tool) => ({
    server: tool.server,
    tool: tool.tool,
    description: tool.description,
    schemaBytes: tool.schemaBytes,
    status: tool.status,
  }));
  const index = buildCapabilityIndex(definition, discovered);
  const selection = query ? selectCapabilities(index, query) : null;
  return {
    factory,
    declaredServers: declaredMcpServers(definition.manifest).map((server) => server.name),
    capabilities: index,
    selection,
  };
}

export async function discoverCapabilitiesForApi(
  config: ApiConfig,
  factory: string,
  body: DiscoverBody,
): Promise<{ discovered: number; capabilities: CapabilityEntry[] }> {
  const definition = loadFactory(config, factory);
  const declared = declaredMcpServers(definition.manifest);
  if (!declared.some((server) => server.name === body.server)) {
    throw invalidRequest(`MCP server "${body.server}" is not declared in the factory definition`, {
      server: body.server,
      declared: declared.map((server) => server.name),
    });
  }

  const sql = getSql();
  for (const tool of body.tools) {
    await upsertMcpTool(sql, {
      factory,
      server: body.server,
      tool: tool.name,
      description: tool.description ?? null,
      schema: tool.schema ?? {},
      schemaBytes: JSON.stringify(tool.schema ?? {}).length,
    });
  }

  return { discovered: body.tools.length, capabilities: (await getCapabilitiesForApi(config, factory, null)).capabilities };
}

export async function promoteCapabilityForApi(
  config: ApiConfig,
  factory: string,
  server: string,
  tool: string,
): Promise<CapabilityEntry> {
  loadFactory(config, factory);
  const promoted = await promoteMcpTool(getSql(), factory, server, tool);
  if (!promoted) {
    throw new ApiError('capability_not_found', 404, `no capability ${server}/${tool}`, {
      server,
      tool,
    });
  }
  return {
    server: promoted.server,
    tool: promoted.tool,
    description: promoted.description,
    schemaBytes: promoted.schemaBytes,
    status: promoted.status,
  };
}
