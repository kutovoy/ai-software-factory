import { declaredMcpServers, loadDefinition, recordMcpTest } from '@factory/core';
import { getSql } from '../db';
import { probeMcpServer } from '../mcp-probe';
import type { McpTestWorkflowInput, McpTestWorkflowOutcome } from '../types';

/**
 * MCP connection test activity (spec `mcp-integration` › connection test).
 *
 * The probe executes here, in the worker/runner host — never in the API process (ADR-010).
 * It reads the git-backed definition (the declared server is authoritative), resolves the
 * credentials locally by name, records the result in `mcp_tests` and flips the server
 * status to `healthy`/`unhealthy`.
 */
export async function testMcpServerActivity(
  input: McpTestWorkflowInput,
): Promise<McpTestWorkflowOutcome> {
  const { definition, errors } = loadDefinition(input.factoryRoot);
  if (!definition) {
    throw new Error(
      `factory "${input.factory}" does not validate: ${errors
        .map((error) => `${error.code} ${error.pointer}`)
        .join(', ')}`,
    );
  }

  const server = declaredMcpServers(definition.manifest).find(
    (candidate) => candidate.name === input.server,
  );
  if (!server) {
    throw new Error(`factory "${input.factory}" declares no MCP server "${input.server}"`);
  }

  const runnerId = `mcp-${input.factory}-${input.server}`;
  const result = await probeMcpServer(
    {
      name: server.name,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      args: [...(server.args ?? [])],
      env: { ...(server.env ?? {}) },
      ...(server.url ? { url: server.url } : {}),
      headers: { ...(server.headers ?? {}) },
    },
    { timeoutMs: input.timeoutMs },
  );

  try {
    await recordMcpTest(getSql(), {
      factory: input.factory,
      server: server.name,
      transport: result.transport,
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
      runnerId,
    });
  } catch (error) {
    console.warn(
      `[mcp] probe result not recorded for ${input.factory}/${server.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    factory: input.factory,
    server: server.name,
    transport: result.transport,
    ok: result.ok,
    latencyMs: result.latencyMs,
    error: result.error,
    executor: result.executor,
  };
}
