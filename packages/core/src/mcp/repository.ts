import type { SQL } from 'bun';

/**
 * MCP capability index (roadmap item 9). Metadata only: tool name, description and schema
 * size. The schema body is kept for promotion/selection, never for credentials.
 */

export interface McpToolRecord {
  factory: string;
  server: string;
  tool: string;
  description: string | null;
  schemaBytes: number;
  status: 'discovered' | 'promoted';
  discoveredAt: string | null;
  updatedAt: string | null;
}

interface ToolRow {
  factory: string;
  server: string;
  tool: string;
  description: string | null;
  schema_bytes: number;
  status: 'discovered' | 'promoted';
  discovered_at: string | null;
  updated_at: string | null;
}

function map(row: ToolRow): McpToolRecord {
  return {
    factory: row.factory,
    server: row.server,
    tool: row.tool,
    description: row.description,
    schemaBytes: Number(row.schema_bytes ?? 0),
    status: row.status,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
}

export async function listMcpTools(sql: SQL, factory: string): Promise<McpToolRecord[]> {
  const rows = (await sql`
    select * from mcp_tools where factory = ${factory} order by server, tool
  `) as ToolRow[];
  return rows.map(map);
}

export async function upsertMcpTool(
  sql: SQL,
  args: {
    factory: string;
    server: string;
    tool: string;
    description?: string | null;
    schema?: unknown;
    schemaBytes: number;
    status?: 'discovered' | 'promoted';
  },
): Promise<McpToolRecord> {
  const rows = (await sql`
    insert into mcp_tools (factory, server, tool, description, schema, schema_bytes, status)
    values (
      ${args.factory}, ${args.server}, ${args.tool}, ${args.description ?? null},
      ${(args.schema ?? {})}::jsonb, ${args.schemaBytes}, ${args.status ?? 'discovered'}
    )
    on conflict (factory, server, tool) do update set
      description = excluded.description,
      schema = excluded.schema,
      schema_bytes = excluded.schema_bytes,
      status = excluded.status,
      updated_at = now()
    returning *
  `) as ToolRow[];
  return map(rows[0] as ToolRow);
}

export async function promoteMcpTool(
  sql: SQL,
  factory: string,
  server: string,
  tool: string,
): Promise<McpToolRecord | null> {
  const rows = (await sql`
    update mcp_tools set status = 'promoted', updated_at = now()
    where factory = ${factory} and server = ${server} and tool = ${tool}
    returning *
  `) as ToolRow[];
  return rows[0] ? map(rows[0]) : null;
}
