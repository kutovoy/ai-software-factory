import { z } from 'zod';
import {
  MCP_TRANSPORTS,
  declaredMcpServers,
  listMcpBindings,
  listMcpServers,
  listMcpTests,
  loadDefinition,
  mcpServerGlob,
  replaceMcpRegistry,
  resolveMcpWiring,
  type AgentDef,
  type FactoryDefinition,
  type McpServerDef,
  type McpServerRecord,
  type McpTestRecord,
} from '@factory/core';
import { getSql, runMcpTest } from '@factory/orchestration';
import type { ApiConfig } from './config';
import { toOrchestrationConfig } from './config';
import { ApiError, definitionInvalid, invalidRequest } from './errors';
import { resolveFactoryDir } from './factories';
import { log } from './logger';

/**
 * MCP registry + per-agent wiring (spec `mcp-integration`, ADR-027).
 *
 * The definition is authoritative: servers are declared in `factory.yaml` and bound on the
 * agent (`agents/<name>/agent.md` → `mcp: [server]`). This module projects the declaration
 * joined with the registry index (status, last probe) and validates every write against it.
 * Probes run in the worker/runner, never here (ADR-010).
 */

export const mcpSyncBodySchema = z
  .object({
    /** Declared servers to register in the index (validated against the definition). */
    servers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            transport: z.enum(MCP_TRANSPORTS).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Agent -> server bindings to register (must already be declared in the definition). */
    bindings: z
      .array(
        z
          .object({
            agent: z.string().min(1),
            server: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type McpSyncBody = z.infer<typeof mcpSyncBodySchema>;

export interface McpAgentView {
  agent: string;
  /** Servers the agent may use. */
  servers: string[];
  /** Glob allow list handed to the harness (`"<server>*"`). */
  allow: string[];
  /** Glob deny list for declared servers the agent does not list. */
  deny: string[];
  declared: boolean;
}

export interface McpServerView {
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  /** Environment key -> secret name (never a value). */
  env: Record<string, string>;
  url: string | null;
  /** Header name -> secret name (never a value). */
  headers: Record<string, string>;
  status: 'untested' | 'healthy' | 'unhealthy';
  /** True once the server is present in the registry index (registerable/testable). */
  registered: boolean;
  description: string | null;
  /** Tool glob the server contributes (`"<server>*"`). */
  toolGlob: string;
  /** Agents bound to this server. */
  agents: string[];
  /** Declared agents that do NOT bind this server (they receive a deny glob). */
  deniedAgents: string[];
  lastTest: {
    ok: boolean;
    transport: string;
    latencyMs: number | null;
    error: string | null;
    runnerId: string | null;
    createdAt: string | null;
  } | null;
}

export interface McpProjection {
  factory: string;
  servers: McpServerView[];
  agents: McpAgentView[];
}

function agentsOf(definition: FactoryDefinition): Array<{ name: string; doc: AgentDef }> {
  return definition.resources
    .filter((resource) => resource.kind === 'agent')
    .map((resource) => ({ name: resource.name, doc: resource.doc as AgentDef }));
}

function loadOrFail(dir: string, factory: string): FactoryDefinition {
  const { definition, errors } = loadDefinition(dir, { requireFactoryId: true });
  if (!definition) throw definitionInvalid(factory, errors);
  return definition;
}

function toTestView(test: McpTestRecord | null): McpServerView['lastTest'] {
  if (!test) return null;
  return {
    ok: test.ok,
    transport: test.transport,
    latencyMs: test.latencyMs,
    error: test.error,
    runnerId: test.runnerId,
    createdAt: test.createdAt,
  };
}

function serverView(
  server: McpServerDef,
  registry: McpServerRecord | undefined,
  boundAgents: string[],
  allAgents: string[],
  lastTest: McpTestRecord | null,
): McpServerView {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command ?? null,
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    url: server.url ?? null,
    headers: { ...(server.headers ?? {}) },
    status: registry?.status ?? 'untested',
    registered: registry !== undefined,
    description: server.description ?? null,
    toolGlob: mcpServerGlob(server.name),
    agents: boundAgents,
    deniedAgents: allAgents.filter((agent) => !boundAgents.includes(agent)),
    lastTest: toTestView(lastTest),
  };
}

function agentView(definition: FactoryDefinition, agent: string): McpAgentView {
  const wiring = resolveMcpWiring(definition, agent);
  return {
    agent,
    servers: wiring.bound,
    allow: Object.entries(wiring.permissions)
      .filter(([, decision]) => decision === 'allow')
      .map(([glob]) => glob),
    deny: Object.entries(wiring.permissions)
      .filter(([, decision]) => decision === 'deny')
      .map(([glob]) => glob),
    declared: true,
  };
}

/** GET /factories/:name/mcp — declared servers + bindings joined with registry state. */
export async function getMcpForApi(config: ApiConfig, factory: string): Promise<McpProjection> {
  const dir = resolveFactoryDir(config, factory);
  const definition = loadOrFail(dir, factory);
  const sql = getSql();

  const [registry, storedBindings, tests] = await Promise.all([
    listMcpServers(sql, factory),
    listMcpBindings(sql, factory),
    listMcpTests(sql, factory),
  ]);

  const registryByName = new Map(registry.map((row) => [row.name, row]));
  const declared = declaredMcpServers(definition.manifest);
  const agents = agentsOf(definition).map((agent) => agent.name);

  const servers: McpServerView[] = declared.map((server) => {
    // Bound agents come from the definition (source of truth); the registry binding rows
    // are the index the page reads, so fall back to them when they exist.
    const boundFromDefinition = agents.filter((agent) =>
      resolveMcpWiring(definition, agent).bound.includes(server.name),
    );
    const boundFromRegistry = storedBindings
      .filter((binding) => binding.server === server.name)
      .map((binding) => binding.agent);
    const bound = [...new Set([...boundFromDefinition, ...boundFromRegistry])];
    const latest = tests.find((test) => test.server === server.name) ?? null;
    return serverView(server, registryByName.get(server.name), bound, agents, latest);
  });

  const agentViews: McpAgentView[] = agents.map((agent) => agentView(definition, agent));

  // Registry-only agents (a binding row without a definition agent) are surfaced too, so a
  // stale index entry is visible rather than silently dropped.
  for (const binding of storedBindings) {
    if (agentViews.some((view) => view.agent === binding.agent)) continue;
    agentViews.push({
      agent: binding.agent,
      servers: storedBindings
        .filter((candidate) => candidate.agent === binding.agent)
        .map((candidate) => candidate.server),
      allow: binding.toolsAllow,
      deny: binding.toolsDeny,
      declared: false,
    });
  }

  return {
    factory,
    servers,
    agents: agentViews.sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

/** POST /factories/:name/mcp — register declared servers/bindings in the index. */
export async function syncMcpForApi(
  config: ApiConfig,
  factory: string,
  body: McpSyncBody,
): Promise<McpProjection> {
  const dir = resolveFactoryDir(config, factory);
  const definition = loadOrFail(dir, factory);
  const declared = new Map(
    declaredMcpServers(definition.manifest).map((server) => [server.name, server]),
  );
  const agents = new Map(agentsOf(definition).map((agent) => [agent.name, agent]));

  for (const server of body.servers ?? []) {
    const declaredServer = declared.get(server.name);
    if (!declaredServer) {
      throw new ApiError(
        'unknown_mcp_server',
        422,
        `factory "${factory}" declares no MCP server "${server.name}"; declare it in factory.yaml first`,
        { factory, server: server.name, declared: [...declared.keys()] },
      );
    }
    if (server.transport && server.transport !== declaredServer.transport) {
      throw invalidRequest(
        `server "${server.name}" is declared as ${declaredServer.transport}, not ${server.transport}`,
        { factory, server: server.name },
      );
    }
  }

  for (const binding of body.bindings ?? []) {
    if (!declared.has(binding.server)) {
      throw new ApiError(
        'unknown_mcp_server',
        422,
        `agent "${binding.agent}" binds unknown MCP server "${binding.server}"`,
        { factory, agent: binding.agent, server: binding.server, declared: [...declared.keys()] },
      );
    }
    if (!agents.has(binding.agent)) {
      throw new ApiError(
        'unknown_agent',
        422,
        `factory "${factory}" declares no agent "${binding.agent}"`,
        { factory, agent: binding.agent },
      );
    }
  }

  const selectedServers = body.servers
    ? body.servers.map((server) => declared.get(server.name) as McpServerDef)
    : [...declared.values()];

  const bindings =
    body.bindings ??
    agentsOf(definition).flatMap((agent) =>
      resolveMcpWiring(definition, agent.name).bound.map((server) => ({
        agent: agent.name,
        server,
      })),
    );

  await replaceMcpRegistry(getSql(), {
    factory,
    servers: selectedServers.map((server) => ({
      factory,
      name: server.name,
      transport: server.transport,
      command: server.command ?? null,
      args: [...(server.args ?? [])],
      env: { ...(server.env ?? {}) },
      url: server.url ?? null,
      headers: { ...(server.headers ?? {}) },
    })),
    bindings: bindings.map((binding) => {
      const wiring = resolveMcpWiring(definition, binding.agent);
      return {
        factory,
        agent: binding.agent,
        server: binding.server,
        toolsAllow: [mcpServerGlob(binding.server)],
        toolsDeny: Object.entries(wiring.permissions)
          .filter(([, decision]) => decision === 'deny')
          .map(([glob]) => glob),
      };
    }),
  });

  log('info', 'mcp_registry_synced', {
    factory,
    servers: selectedServers.map((server) => server.name),
    bindings: bindings.length,
  });

  return getMcpForApi(config, factory);
}

export interface McpTestView {
  factory: string;
  server: string;
  workflowId: string;
  result: {
    ok: boolean;
    transport: string;
    latencyMs: number;
    error: string | null;
    executor: string;
  };
}

/** POST /factories/:name/mcp/:server/test — probe in the runner, record the result. */
export async function testMcpForApi(
  config: ApiConfig,
  factory: string,
  serverName: string,
): Promise<McpTestView> {
  const dir = resolveFactoryDir(config, factory);
  const definition = loadOrFail(dir, factory);
  const declared = declaredMcpServers(definition.manifest).find(
    (server) => server.name === serverName,
  );
  if (!declared) {
    throw new ApiError(
      'mcp_server_not_found',
      404,
      `factory "${factory}" declares no MCP server "${serverName}"`,
      { factory, server: serverName },
    );
  }

  let started: Awaited<ReturnType<typeof runMcpTest>>;
  try {
    started = await runMcpTest(
      { factory, factoryRoot: dir, server: serverName },
      toOrchestrationConfig(config),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log('error', 'mcp_test_failed', { factory, server: serverName, message });
    throw new ApiError('orchestrator_unavailable', 503, 'could not run the MCP probe', {
      factory,
      server: serverName,
      error: message,
    });
  }

  log('info', 'mcp_test_completed', {
    factory,
    server: serverName,
    ok: started.outcome.ok,
    transport: started.outcome.transport,
    latencyMs: started.outcome.latencyMs,
  });

  return {
    factory,
    server: serverName,
    workflowId: started.workflowId,
    result: {
      ok: started.outcome.ok,
      transport: started.outcome.transport,
      latencyMs: started.outcome.latencyMs,
      error: started.outcome.error,
      executor: started.outcome.executor,
    },
  };
}
