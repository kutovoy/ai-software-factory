import type { AgentDef } from '../schema/agent';
import type { FactoryManifest } from '../schema/factory';
import type { McpServerDef } from '../schema/mcp';

/**
 * Secret *references* declared by a definition (ADR-026).
 *
 * Everything here is a name. The registry never stores values, so this list is also the
 * delete guard: a secret referenced by a definition cannot be removed.
 */

export interface SecretReference {
  name: string;
  /** Where the reference lives: `factory`, `agent`, `agentDefaults` or `mcp`. */
  kind: 'factory' | 'agent' | 'agentDefaults' | 'mcp';
  /** Resource identity (`factory.yaml`, the agent name, or `mcp:<server>`). */
  resource: string;
  /** JSON pointer of the reference inside that resource. */
  pointer: string;
}

export interface NamedAgent {
  name: string;
  doc: AgentDef;
}

/** The declared MCP servers: `mcp.servers` first, the legacy `mcpServers` map after. */
export function declaredMcpServers(manifest: FactoryManifest): McpServerDef[] {
  const declared = new Map<string, McpServerDef>();
  for (const server of manifest.mcp?.servers ?? []) declared.set(server.name, server);

  // Legacy `mcpServers` is a map of name -> opaque config. Only `command`/`args`/`url`
  // are understood; it is normalised into a server so the adapter can still wire it.
  for (const [name, value] of Object.entries(manifest.mcpServers ?? {})) {
    if (declared.has(name)) continue;
    const config = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const command = typeof config.command === 'string' ? config.command : undefined;
    const args = Array.isArray(config.args)
      ? config.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const url = typeof config.url === 'string' ? config.url : undefined;
    declared.set(name, {
      name,
      transport: url ? 'http' : 'stdio',
      ...(command ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(url ? { url } : {}),
    });
  }

  return [...declared.values()];
}

/** Every secret name a definition references, in document order. */
export function collectSecretReferences(
  manifest: FactoryManifest,
  agents: ReadonlyArray<NamedAgent> = [],
): SecretReference[] {
  const references: SecretReference[] = [];

  manifest.secrets.forEach((name, index) => {
    references.push({ name, kind: 'factory', resource: 'factory.yaml', pointer: `/secrets/${index}` });
  });

  (manifest.agentDefaults.secrets ?? []).forEach((name, index) => {
    references.push({
      name,
      kind: 'agentDefaults',
      resource: 'factory.yaml',
      pointer: `/agentDefaults/secrets/${index}`,
    });
  });

  const defaultsSecret = manifest.agentDefaults.harness?.auth?.secretName;
  if (defaultsSecret) {
    references.push({
      name: defaultsSecret,
      kind: 'agentDefaults',
      resource: 'factory.yaml',
      pointer: '/agentDefaults/harness/auth/secretName',
    });
  }

  for (const server of declaredMcpServers(manifest)) {
    for (const [key, name] of Object.entries(server.env ?? {})) {
      references.push({
        name,
        kind: 'mcp',
        resource: `mcp:${server.name}`,
        pointer: `/mcp/servers/${server.name}/env/${key}`,
      });
    }
    for (const [key, name] of Object.entries(server.headers ?? {})) {
      references.push({
        name,
        kind: 'mcp',
        resource: `mcp:${server.name}`,
        pointer: `/mcp/servers/${server.name}/headers/${key}`,
      });
    }
  }

  for (const agent of agents) {
    (agent.doc.secrets ?? []).forEach((name, index) => {
      references.push({
        name,
        kind: 'agent',
        resource: agent.name,
        pointer: `/secrets/${index}`,
      });
    });
    const agentSecret = agent.doc.harness?.auth?.secretName;
    if (agentSecret) {
      references.push({
        name: agentSecret,
        kind: 'agent',
        resource: agent.name,
        pointer: '/harness/auth/secretName',
      });
    }
  }

  return references;
}

/** Distinct secret names referenced by a definition. */
export function referencedSecretNames(
  manifest: FactoryManifest,
  agents: ReadonlyArray<NamedAgent> = [],
): string[] {
  return [...new Set(collectSecretReferences(manifest, agents).map((reference) => reference.name))];
}
