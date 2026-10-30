import { z } from 'zod';
import { addIssue, codedString, secretNameSchema } from './common';

/**
 * MCP server declaration (spec `mcp-integration`).
 *
 * A server is declared once on the factory and bound to agents by name. Credentials are
 * **references**: `env` and `headers` map a runtime key to a secret *name*, never a value
 * (ADR-026). A credential-looking literal anywhere in the declaration is rejected with
 * `secret_inline_rejected` instead of being silently stored.
 */

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const mcpServerNameSchema = codedString(
  MCP_SERVER_NAME_RE,
  'invalid_value',
  'MCP server name must be lowercase letters, digits, ".", "_" or "-"',
);

/**
 * Credential-shaped literals. Deliberately narrow: a secret *name* such as
 * `GITHUB_TOKEN` must stay valid, so only recognisable token prefixes and bearer/JWT
 * payloads are matched.
 */
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}/,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export function looksLikeInlineSecret(value: string): boolean {
  return INLINE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

export const mcpServerSchema = z
  .object({
    name: mcpServerNameSchema,
    transport: z.enum(MCP_TRANSPORTS),
    description: z.string().min(1).optional(),
    /** stdio: the command to spawn. */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    /** stdio: environment key -> secret *name*. */
    env: z.record(z.string(), secretNameSchema).optional(),
    /** http: the remote endpoint. */
    url: z.string().min(1).optional(),
    /** http: header name -> secret *name*. */
    headers: z.record(z.string(), secretNameSchema).optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio') {
      if (!server.command) {
        addIssue(ctx, 'missing_field', 'a stdio MCP server requires command', ['command']);
      }
      if (server.url) {
        addIssue(ctx, 'invalid_value', 'a stdio MCP server must not declare url', ['url']);
      }
      if (server.headers) {
        addIssue(ctx, 'invalid_value', 'a stdio MCP server must not declare headers', ['headers']);
      }
    } else {
      if (!server.url) {
        addIssue(ctx, 'missing_field', 'an http MCP server requires url', ['url']);
      }
      if (server.command) {
        addIssue(ctx, 'invalid_value', 'an http MCP server must not declare command', ['command']);
      }
      if (server.args) {
        addIssue(ctx, 'invalid_value', 'an http MCP server must not declare args', ['args']);
      }
      if (server.env) {
        addIssue(ctx, 'invalid_value', 'an http MCP server must not declare env', ['env']);
      }
    }

    if (server.command && looksLikeInlineSecret(server.command)) {
      addIssue(
        ctx,
        'secret_inline_rejected',
        'command contains a credential literal; reference a secret name instead',
        ['command'],
      );
    }
    server.args?.forEach((arg, index) => {
      if (looksLikeInlineSecret(arg)) {
        addIssue(
          ctx,
          'secret_inline_rejected',
          'args contain a credential literal; reference a secret name instead',
          ['args', index],
        );
      }
    });
    if (server.url && looksLikeInlineSecret(server.url)) {
      addIssue(
        ctx,
        'secret_inline_rejected',
        'url contains a credential literal; reference a secret name instead',
        ['url'],
      );
    }
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (looksLikeInlineSecret(value)) {
        addIssue(
          ctx,
          'secret_inline_rejected',
          `env ${key} holds a credential literal; use a secret name`,
          ['env', key],
        );
      }
    }
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (looksLikeInlineSecret(value)) {
        addIssue(
          ctx,
          'secret_inline_rejected',
          `header ${key} holds a credential literal; use a secret name`,
          ['headers', key],
        );
      }
    }
  });

export const mcpSchema = z
  .object({
    servers: z.array(mcpServerSchema).default([]),
  })
  .strict()
  .superRefine((mcp, ctx) => {
    const seen = new Set<string>();
    mcp.servers.forEach((server, index) => {
      if (seen.has(server.name)) {
        addIssue(ctx, 'duplicate_identity', `MCP server "${server.name}" is declared twice`, [
          'servers',
          index,
          'name',
        ]);
      }
      seen.add(server.name);
    });
  });

export type McpServerDef = z.infer<typeof mcpServerSchema>;
export type McpDef = z.infer<typeof mcpSchema>;
