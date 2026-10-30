'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import type { McpProjectionWire, McpTestResponseWire } from '@/lib/types';

/**
 * MCP registry + per-agent wiring (spec `mcp-integration`, ADR-027).
 *
 * Servers are declared in `factory.yaml`; this page registers a declared server in the
 * index, shows which agents bind it (and the tool globs each agent receives), and runs a
 * transport-level probe. The probe executes in the runner, so a failure here is a real
 * runtime result — a missing command is `unhealthy`, not a definition error.
 */

interface TestState {
  ok: boolean;
  transport: string;
  latencyMs: number;
  error: string | null;
  executor: string;
}

function statusTone(status: string): 'success' | 'danger' | 'neutral' {
  if (status === 'healthy') return 'success';
  if (status === 'unhealthy') return 'danger';
  return 'neutral';
}

export function McpPanel({
  factory,
  projection,
  unregistered,
}: {
  factory: string;
  projection: McpProjectionWire;
  /** Declared servers that are not in the index yet. */
  unregistered: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(unregistered[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const field =
    'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900';

  const register = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!selected) {
      setError('choose a server declared in factory.yaml');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/factories/${encodeURIComponent(factory)}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servers: [{ name: selected }] }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
      if (!response.ok) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `registration failed (${response.status})`}`,
        );
      }
      setNotice(`Registered ${selected} in the MCP index.`);
      setOpen(false);
      router.refresh();
    } catch (registerError) {
      setError(registerError instanceof Error ? registerError.message : String(registerError));
    } finally {
      setBusy(false);
    }
  };

  const test = async (server: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setPending(server);
    try {
      const response = await fetch(
        `/api/factories/${encodeURIComponent(factory)}/mcp/${encodeURIComponent(server)}/test`,
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => ({}))) as
        | McpTestResponseWire
        | { message?: string; code?: string };
      if (!response.ok || !('result' in body)) {
        const failure = body as { message?: string; code?: string };
        throw new Error(
          `${failure.code ? `${failure.code}: ` : ''}${failure.message ?? `probe failed (${response.status})`}`,
        );
      }
      setTests((current) => ({ ...current, [server]: body.result }));
      router.refresh();
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : String(testError));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="mcp-add-toggle"
          onClick={() => {
            setOpen((value) => !value);
            setError(null);
          }}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {open ? 'Close' : 'Add server'}
        </button>
        <span className="text-xs text-slate-500">
          Servers are declared in <span className="font-mono">factory.yaml</span>; this registers a
          declared server in the index so it can be tested.
        </span>
      </div>

      {open ? (
        <form
          data-testid="mcp-add-form"
          onSubmit={(event) => void register(event)}
          className="space-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
        >
          {unregistered.length === 0 ? (
            <p className="text-xs text-slate-500" data-testid="mcp-add-none">
              Every declared server is already registered. Add another server to{' '}
              <span className="font-mono">factory.yaml</span> and re-register it here.
            </p>
          ) : (
            <label className="text-xs text-slate-600">
              Declared server
              <select
                data-testid="mcp-add-select"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
                className={field}
              >
                {unregistered.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="mcp-add-submit"
              disabled={busy || unregistered.length === 0}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Registering…' : 'Register server'}
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p data-testid="mcp-form-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="mcp-form-notice" className="text-xs text-emerald-700">
          {notice}
        </p>
      ) : null}

      {projection.servers.length === 0 ? (
        <EmptyState
          testId="mcp-empty"
          title="No MCP servers declared"
          description="Declare a server under `mcp.servers` in factory.yaml (transport, command or url, and secret names for credentials), then bind it to an agent with `mcp: [server]`."
        />
      ) : (
        <Table
          testId="mcp-servers-table"
          rowTestId="mcp-server-row"
          rows={projection.servers}
          rowKey={(server) => server.name}
          columns={[
            {
              header: 'Server',
              cell: (server) => (
                <span className="font-mono text-xs text-slate-800" data-testid="mcp-server-name">
                  {server.name}
                </span>
              ),
            },
            {
              header: 'Transport',
              cell: (server) => (
                <span className="text-xs text-slate-700" data-testid="mcp-server-transport">
                  {server.transport}
                  {server.transport === 'stdio' ? (
                    <span className="ml-1 font-mono text-[11px] text-slate-500">
                      {[server.command, ...server.args].filter(Boolean).join(' ')}
                    </span>
                  ) : (
                    <span className="ml-1 font-mono text-[11px] text-slate-500">{server.url}</span>
                  )}
                </span>
              ),
            },
            {
              header: 'Status',
              cell: (server) => (
                <Badge tone={statusTone(server.status)} testId="mcp-server-status">
                  {server.status}
                </Badge>
              ),
            },
            {
              header: 'Agents bound',
              cell: (server) => (
                <span className="text-xs text-slate-700" data-testid="mcp-server-agents">
                  {server.agents.length > 0 ? server.agents.join(', ') : 'none — every agent denies it'}
                  {server.deniedAgents.length > 0 ? (
                    <span className="ml-1 text-slate-500">(denied: {server.deniedAgents.join(', ')})</span>
                  ) : null}
                </span>
              ),
            },
            {
              header: 'Tool glob',
              cell: (server) => (
                <span className="text-xs" data-testid="mcp-server-tools">
                  <Badge tone="info" mono>
                    {server.toolGlob}
                  </Badge>{' '}
                  {server.agents.length > 0 ? 'allow' : 'deny'}
                </span>
              ),
            },
            {
              header: 'Credentials (names)',
              cell: (server) => {
                const entries = [
                  ...Object.entries(server.env).map(([key, name]) => `${key}=${name}`),
                  ...Object.entries(server.headers).map(([key, name]) => `${key}=${name}`),
                ];
                return (
                  <span className="font-mono text-[11px] text-slate-600" data-testid="mcp-server-secrets">
                    {entries.length > 0 ? entries.join(', ') : 'none'}
                  </span>
                );
              },
            },
            {
              header: 'Last test',
              cell: (server) => {
                const live = tests[server.name];
                const result = live ?? server.lastTest;
                return (
                  <span className="space-y-1 text-xs" data-testid="mcp-test-result">
                    {result ? (
                      <>
                        <span className={result.ok ? 'text-emerald-700' : 'text-red-700'}>
                          {result.ok ? 'reachable' : 'failed'} · {result.transport} ·{' '}
                          {result.latencyMs ?? 0}ms
                        </span>
                        {result.error ? (
                          <span className="block text-[11px] text-red-700">{result.error}</span>
                        ) : null}
                        <span className="block text-[11px] text-slate-500">
                          ran in {('executor' in result ? result.executor : 'runner')}
                          {server.lastTest?.createdAt
                            ? ` · ${server.lastTest.createdAt.replace('T', ' ').slice(0, 16)}`
                            : ''}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-500">never tested</span>
                    )}
                  </span>
                );
              },
            },
            {
              header: 'Actions',
              cell: (server) => (
                <button
                  type="button"
                  data-testid="mcp-test-button"
                  data-server={server.name}
                  disabled={pending !== null}
                  onClick={() => void test(server.name)}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                >
                  {pending === server.name ? 'Testing…' : 'Test'}
                </button>
              ),
            },
          ]}
        />
      )}

      {projection.agents.length === 0 ? null : (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">Agent bindings</h2>
          <p className="text-xs text-slate-500">
            Bound servers get an <span className="font-mono">&quot;&lt;server&gt;*&quot;: allow</span>{' '}
            glob; every declared server an agent does not list gets an explicit deny.
          </p>
          <Table
            testId="mcp-agents-table"
            rowTestId="mcp-agent-row"
            rows={projection.agents}
            rowKey={(agent) => agent.agent}
            columns={[
              {
                header: 'Agent',
                cell: (agent) => (
                  <span className="font-mono text-xs text-slate-800" data-testid="mcp-agent-name">
                    {agent.agent}
                  </span>
                ),
              },
              {
                header: 'Servers',
                cell: (agent) => (
                  <span className="text-xs text-slate-700" data-testid="mcp-agent-servers">
                    {agent.servers.length > 0 ? agent.servers.join(', ') : 'none'}
                  </span>
                ),
              },
              {
                header: 'Allowed',
                cell: (agent) => (
                  <span className="flex flex-wrap gap-1" data-testid="mcp-agent-allow">
                    {agent.allow.length === 0 ? (
                      <span className="text-xs text-slate-400">nothing</span>
                    ) : (
                      agent.allow.map((glob) => (
                        <Badge key={glob} tone="success" mono>
                          {glob}
                        </Badge>
                      ))
                    )}
                  </span>
                ),
              },
              {
                header: 'Denied',
                cell: (agent) => (
                  <span className="flex flex-wrap gap-1" data-testid="mcp-agent-deny">
                    {agent.deny.length === 0 ? (
                      <span className="text-xs text-slate-400">nothing</span>
                    ) : (
                      agent.deny.map((glob) => (
                        <Badge key={glob} tone="danger" mono>
                          {glob}
                        </Badge>
                      ))
                    )}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}
