'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table } from '@/components/ui/Table';
import type { SecretViewWire, UnregisteredSecretWire } from '@/lib/types';

/**
 * Secrets registry (spec `secrets`, ADR-026).
 *
 * The console only ever sends a **name** and metadata: the API stores no value and never
 * returns one, not even masked. "Rotate" re-registers metadata and bumps the timestamp —
 * the operator rotates the value where it lives. Deleting an in-use name is refused with
 * the referencing resources, which this panel shows verbatim.
 */

interface FormState {
  name: string;
  provider: string;
  scope: string;
  description: string;
}

const EMPTY_FORM: FormState = { name: '', provider: 'env', scope: 'factory', description: '' };

function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

export function SecretsPanel({
  secrets,
  unregistered,
}: {
  secrets: SecretViewWire[];
  /** Referenced by a definition but not registered (the `secret_unregistered` warning). */
  unregistered: UnregisteredSecretWire[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(secrets.length === 0);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const field =
    'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900';

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!form.name.trim()) {
      setError('a secret name is required');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          provider: form.provider,
          scope: form.scope,
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        secret?: { name?: string; status?: string };
      };
      if (!response.ok) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `registration failed (${response.status})`}`,
        );
      }
      setNotice(
        body.secret?.status === 'resolved'
          ? `Registered ${body.secret.name}: the name resolves in the environment.`
          : `Registered ${body.secret?.name}: the name does not resolve yet — the first real run will fail until the value is provided.`,
      );
      setForm(EMPTY_FORM);
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (name: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setPending(`rotate:${name}`);
    try {
      const response = await fetch(`/api/secrets/${encodeURIComponent(name)}/rotate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        secret?: { status?: string };
      };
      if (!response.ok) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `rotation failed (${response.status})`}`,
        );
      }
      setNotice(
        `Rotated ${name}: metadata re-registered and the timestamp bumped. The value itself is unchanged — rotate it where it lives.`,
      );
      router.refresh();
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : String(rotateError));
    } finally {
      setPending(null);
    }
  };

  const remove = async (name: string): Promise<void> => {
    setError(null);
    setNotice(null);
    setPending(`delete:${name}`);
    try {
      const response = await fetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        code?: string;
        details?: { references?: { kind: string; resource: string; pointer: string }[] };
      };
      if (!response.ok) {
        const references = body.details?.references ?? [];
        const detail =
          body.code === 'secret_in_use' && references.length > 0
            ? ` (referenced by ${references
                .map((reference) => `${reference.kind}:${reference.resource}`)
                .join(', ')})`
            : '';
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `delete failed (${response.status})`}${detail}`,
        );
      }
      setNotice(`Deleted ${name}.`);
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="secret-create-toggle"
          onClick={() => {
            setOpen((value) => !value);
            setError(null);
          }}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {open ? 'Close' : 'Register secret'}
        </button>
        <span className="text-xs text-slate-500">
          A name plus where the value lives. The value is never entered here.
        </span>
      </div>

      {open ? (
        <form
          data-testid="secret-create-form"
          onSubmit={(event) => void submit(event)}
          className="space-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-600">
              Name
              <input
                data-testid="secret-create-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="GITHUB_TOKEN"
                className={field}
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                [A-Za-z_][A-Za-z0-9_]* — the name a definition references.
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Provider
              <select
                data-testid="secret-create-provider"
                value={form.provider}
                onChange={(event) => setForm({ ...form, provider: event.target.value })}
                className={field}
              >
                <option value="env">env (process environment)</option>
                <option value="managed">managed (external store)</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Scope
              <select
                data-testid="secret-create-scope"
                value={form.scope}
                onChange={(event) => setForm({ ...form, scope: event.target.value })}
                className={field}
              >
                <option value="factory">factory</option>
                <option value="workspace">workspace</option>
                <option value="global">global</option>
              </select>
            </label>
          </div>

          <label className="block text-xs text-slate-600">
            Description (optional)
            <input
              data-testid="secret-create-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="What uses it"
              className={field}
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              data-testid="secret-create-submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Registering…' : 'Register'}
            </button>
            <span className="text-[11px] text-slate-500">
              Presence is checked, not custody: the registry reports whether the name resolves.
            </span>
          </div>
        </form>
      ) : null}

      {error ? (
        <p data-testid="secret-form-error" role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p data-testid="secret-form-notice" className="text-xs text-emerald-700">
          {notice}
        </p>
      ) : null}

      {unregistered.length > 0 ? (
        <div
          data-testid="secrets-unregistered"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800"
        >
          <p className="font-semibold">Referenced but not registered</p>
          <p className="mt-1">
            A definition references these names, so a run will fail until they are provided.
            Registering a name only records the metadata — it does not create the value.
          </p>
          <ul className="mt-1 space-y-0.5">
            {unregistered.map((entry) => (
              <li key={entry.name}>
                <span className="font-mono">{entry.name}</span>{' '}
                <span className="text-amber-700">
                  ({entry.references.map((reference) => reference.resource).join(', ')})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {secrets.length === 0 ? (
        <EmptyState
          testId="secrets-empty"
          title="No secrets registered"
          description="Definitions reference secrets by name. Register a name here to check that it resolves in the runtime environment and to see which runs used it. Values are never stored or shown."
        />
      ) : (
        <Table
          testId="secrets-table"
          rowTestId="secret-row"
          rows={secrets}
          rowKey={(secret) => secret.name}
          columns={[
            {
              header: 'Name',
              cell: (secret) => (
                <span className="font-mono text-xs text-slate-800" data-testid="secret-name">
                  {secret.name}
                </span>
              ),
            },
            { header: 'Provider', cell: (secret) => <span className="text-xs">{secret.provider}</span> },
            { header: 'Scope', cell: (secret) => <span className="text-xs">{secret.scope}</span> },
            {
              header: 'Status',
              cell: (secret) => (
                <Badge
                  tone={secret.status === 'resolved' ? 'success' : 'warning'}
                  testId="secret-status"
                >
                  {secret.status}
                </Badge>
              ),
            },
            {
              header: 'Last rotation',
              cell: (secret) => (
                <span className="text-xs text-slate-600" data-testid="secret-last-rotation">
                  {formatWhen(secret.lastRotatedAt)}
                </span>
              ),
            },
            {
              header: 'Last used',
              cell: (secret) => (
                <span className="text-xs text-slate-600" data-testid="secret-last-used">
                  {secret.lastRunId
                    ? `${secret.lastRunId} · ${secret.useCount} use${secret.useCount === 1 ? '' : 's'}`
                    : 'never used by a run'}
                </span>
              ),
            },
            {
              header: 'Actions',
              cell: (secret) => (
                <span className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="secret-rotate"
                    data-secret={secret.name}
                    disabled={pending !== null}
                    onClick={() => void rotate(secret.name)}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                  >
                    {pending === `rotate:${secret.name}` ? 'Rotating…' : 'Rotate'}
                  </button>
                  <button
                    type="button"
                    data-testid="secret-delete"
                    data-secret={secret.name}
                    disabled={pending !== null}
                    onClick={() => void remove(secret.name)}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                  >
                    {pending === `delete:${secret.name}` ? 'Deleting…' : 'Delete'}
                  </button>
                </span>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
