import type { JsonValue } from './events';

/**
 * MCP wiring handed to a harness (spec `mcp-integration` › per-agent binding, ADR-027).
 *
 * Everything here is a **name**: `env`/`headers` map a runtime key to a secret name and the
 * adapter renders it as an `{env:NAME}` template, so no value ever enters the payload
 * (ADR-026). The orchestrator resolves this from the definition; adapters only translate.
 */

export type McpTransportName = 'stdio' | 'http';

export interface McpServerSpec {
  name: string;
  transport: McpTransportName;
  /** stdio: command to spawn. */
  command?: string;
  args?: string[];
  /** stdio: environment key -> secret name. */
  env?: Record<string, string>;
  /** http: endpoint. */
  url?: string;
  /** http: header name -> secret name. */
  headers?: Record<string, string>;
}

export interface McpSessionWiring {
  /** Only the servers this agent may use. Empty means "no MCP servers". */
  servers: McpServerSpec[];
  /** Permission globs: `"<server>*": allow|deny` for every declared server. */
  permissions: Record<string, 'allow' | 'deny'>;
  /** Agent the wiring was resolved for; absent for a run that names no agent. */
  agent?: string;
}

/** opencode config fragment: `mcp`, `permission`, and the per-agent override. */
export interface OpencodeSessionConfig {
  mcp: Record<string, JsonValue>;
  permission: Record<string, JsonValue>;
  agent?: Record<string, JsonValue>;
}

function envTemplate(name: string): string {
  return `{env:${name}}`;
}

function renderEnv(env: Record<string, string> | undefined): Record<string, JsonValue> {
  const rendered: Record<string, JsonValue> = {};
  for (const [key, secretName] of Object.entries(env ?? {})) {
    rendered[key] = envTemplate(secretName);
  }
  return rendered;
}

/**
 * Builds the opencode session config for the requested wiring, per
 * <https://opencode.ai/docs/mcp-servers/> (`type: local|remote`, `environment`, `headers`)
 * and <https://opencode.ai/docs/permissions/> (per-agent `permission` merge, last match
 * wins). Values are always `{env:NAME}` templates, never credentials.
 */
export function buildOpencodeSessionConfig(wiring: McpSessionWiring): OpencodeSessionConfig {
  const mcp: Record<string, JsonValue> = {};
  for (const server of wiring.servers) {
    if (server.transport === 'stdio') {
      const command = [server.command ?? '', ...(server.args ?? [])].filter(
        (part) => part.length > 0,
      );
      mcp[server.name] = {
        type: 'local',
        command,
        ...(Object.keys(server.env ?? {}).length > 0
          ? { environment: renderEnv(server.env) }
          : {}),
        enabled: true,
      };
      continue;
    }
    mcp[server.name] = {
      type: 'remote',
      url: server.url ?? '',
      ...(Object.keys(server.headers ?? {}).length > 0 ? { headers: renderEnv(server.headers) } : {}),
      enabled: true,
    };
  }

  const permission: Record<string, JsonValue> = {};
  for (const [glob, decision] of Object.entries(wiring.permissions)) {
    permission[glob] = decision;
  }

  const config: OpencodeSessionConfig = { mcp, permission };
  if (wiring.agent) {
    // Agent permissions are merged over the global config and take precedence, so the
    // same globs are repeated on the agent — the explicit source of truth.
    config.agent = { [wiring.agent]: { permission: { ...permission } } };
  }
  return config;
}

/**
 * Canonical capability flags for a harness that cannot host MCP servers (spec: map to
 * capability flags, recorded, best effort). The requested wiring is recorded on the
 * session handle so the run detail shows what was asked for and why it was not applied.
 */
export interface McpCapabilityRecord {
  supported: false;
  /** `recorded`: the harness has no MCP support; the request is logged, not applied. */
  mode: 'recorded';
  servers: string[];
  permissions: Record<string, 'allow' | 'deny'>;
}

export function canonicalMcpCapabilityRecord(wiring: McpSessionWiring): McpCapabilityRecord {
  return {
    supported: false,
    mode: 'recorded',
    servers: wiring.servers.map((server) => server.name),
    permissions: { ...wiring.permissions },
  };
}
