import type { FactoryDefinition } from '../loader/load';
import type { McpTransport } from '../schema/mcp';
import { declaredMcpServers } from '../secrets/references';
import type { NamedAgent } from '../secrets/references';

/**
 * Per-agent MCP wiring (spec `mcp-integration` › per-agent binding, ADR-027).
 *
 * The harness receives only the servers the agent lists. Every declared-but-unlisted
 * server gets an explicit `"<server>*": "deny"` glob, so the resolved config states the
 * denial instead of relying on a harness default. Nothing here carries a secret value:
 * `env`/`headers` map a runtime key to a secret *name*.
 */

export interface McpWiringServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  /** Environment key -> secret name. */
  env: Record<string, string>;
  url?: string;
  /** Header name -> secret name. */
  headers: Record<string, string>;
}

export type McpPermission = 'allow' | 'deny';

export interface McpWiring {
  /** Servers the agent may use; empty when the agent declares no binding. */
  servers: McpWiringServer[];
  /** Agent whose allow list applied; `null` when the run names no agent. */
  agent: string | null;
  /** Names of the servers the agent listed. */
  bound: string[];
  /** Permission globs for every declared server: `"<server>*": allow|deny`. */
  permissions: Record<string, McpPermission>;
}

export function mcpServerGlob(server: string): string {
  return `${server}*`;
}

export function agentMcpAllowList(agent: NamedAgent | null): string[] {
  if (!agent) return [];
  return [...new Set([...(agent.doc.mcp ?? []), ...(agent.doc.mcpServers ?? [])])];
}

export function resolveMcpWiring(
  definition: FactoryDefinition,
  agentName?: string | null,
): McpWiring {
  const agents: NamedAgent[] = definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as NamedAgent['doc'] }));

  const agent = agentName ? (agents.find((candidate) => candidate.name === agentName) ?? null) : null;
  const allow = agentMcpAllowList(agent);
  const declared = declaredMcpServers(definition.manifest);

  const servers: McpWiringServer[] = declared
    .filter((server) => allow.includes(server.name))
    .map((server) => ({
      name: server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      args: [...(server.args ?? [])],
      env: { ...(server.env ?? {}) },
      ...(server.url ? { url: server.url } : {}),
      headers: { ...(server.headers ?? {}) },
    }));

  const permissions: Record<string, McpPermission> = {};
  for (const server of declared) {
    permissions[mcpServerGlob(server.name)] = allow.includes(server.name) ? 'allow' : 'deny';
  }

  return {
    servers,
    agent: agent?.name ?? null,
    bound: servers.map((server) => server.name),
    permissions,
  };
}
