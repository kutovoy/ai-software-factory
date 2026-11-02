'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Table, type Column } from '@/components/ui/Table';
import type { UserRole, UserWire } from '@/lib/types';

/**
 * User administration (spec `console-auth` › User administration). Admins list users,
 * create accounts, change roles and disable/enable accounts. Every mutation goes through
 * the console's same-origin `/api/v1` proxy, which forwards the session cookie.
 */

interface CreateForm {
  email: string;
  username: string;
  name: string;
  role: UserRole;
  password: string;
}

const EMPTY_FORM: CreateForm = {
  email: '',
  username: '',
  name: '',
  role: 'member',
  password: '',
};

interface ApiErrorBody {
  code?: string;
  message?: string;
}

export function UsersAdmin({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserWire[];
  currentUserId: string | null;
}) {
  const router = useRouter();
  const [users, setUsers] = useState<UserWire[]>(initialUsers);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const field =
    'mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900';

  const replaceUser = (updated: UserWire): void => {
    setUsers((current) =>
      current.map((user) => (user.id === updated.id ? updated : user)),
    );
  };

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (!form.email.trim() || !form.username.trim() || form.password.length < 8) {
      setError('Email, username and a password of at least 8 characters are required.');
      return;
    }

    setCreating(true);
    try {
      const response = await fetch('/api/v1/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          username: form.username.trim(),
          ...(form.name.trim() ? { name: form.name.trim() } : {}),
          role: form.role,
          password: form.password,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody & {
        user?: UserWire;
      };
      if (!response.ok || !body.user) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `user creation failed (${response.status})`}`,
        );
      }
      setUsers((current) => [...current, body.user as UserWire]);
      setForm(EMPTY_FORM);
      setNotice(`Created ${body.user.email} (${body.user.role}).`);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setCreating(false);
    }
  };

  const update = async (
    user: UserWire,
    patch: { role?: UserRole; disabled?: boolean },
  ): Promise<void> => {
    setError(null);
    setNotice(null);
    setPending(user.id);
    try {
      const response = await fetch(`/api/v1/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody & {
        user?: UserWire;
      };
      if (!response.ok || !body.user) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `update failed (${response.status})`}`,
        );
      }
      replaceUser(body.user);
      setNotice(
        patch.role
          ? `${body.user.email} is now ${body.user.role}.`
          : `${body.user.email} is now ${body.user.disabled ? 'disabled' : 'active'}.`,
      );
      router.refresh();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setPending(null);
    }
  };

  const remove = async (user: UserWire): Promise<void> => {
    if (user.id === currentUserId) {
      setError('You cannot delete the account you are signed in as.');
      return;
    }
    if (!window.confirm(`Delete ${user.email}? Their sessions are revoked and their work becomes admin-only.`)) {
      return;
    }

    setError(null);
    setNotice(null);
    setPending(user.id);
    try {
      const response = await fetch(`/api/v1/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
      });
      const body = (await response.json().catch(() => ({}))) as ApiErrorBody & {
        deleted?: boolean;
      };
      if (!response.ok || !body.deleted) {
        throw new Error(
          `${body.code ? `${body.code}: ` : ''}${body.message ?? `delete failed (${response.status})`}`,
        );
      }
      setUsers((current) => current.filter((candidate) => candidate.id !== user.id));
      setNotice(`Deleted ${user.email}.`);
      router.refresh();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setPending(null);
    }
  };

  const columns: Column<UserWire>[] = [
    {
      header: 'Email',
      cell: (user) => (
        <span data-testid="user-email" className="font-medium text-slate-800">
          {user.email}
        </span>
      ),
    },
    {
      header: 'Username',
      cell: (user) => (
        <code data-testid="user-username" className="text-xs text-slate-600">
          {user.username}
        </code>
      ),
    },
    {
      header: 'Name',
      cell: (user) => <span data-testid="user-name">{user.name ?? '—'}</span>,
    },
    {
      header: 'Role',
      cell: (user) => (
        <select
          data-testid="user-role-select"
          aria-label={`Role for ${user.email}`}
          value={user.role}
          disabled={pending === user.id}
          onChange={(event) =>
            void update(user, { role: event.target.value as UserRole })
          }
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700"
        >
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      ),
    },
    {
      header: 'Status',
      cell: (user) => (
        <div className="flex items-center gap-2">
          <Badge
            tone={user.disabled ? 'danger' : 'success'}
            testId="user-status"
          >
            {user.disabled ? 'disabled' : 'active'}
          </Badge>
          <button
            type="button"
            data-testid="user-toggle-disabled"
            disabled={pending === user.id}
            onClick={() => void update(user, { disabled: !user.disabled })}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            {user.disabled ? 'Enable' : 'Disable'}
          </button>
        </div>
      ),
    },
    {
      header: 'Forge org',
      cell: (user) => (
        <code data-testid="user-forge-org" className="text-xs text-slate-600">
          {user.forgeOrg ?? '—'}
        </code>
      ),
    },
    {
      header: 'Actions',
      cell: (user) => (
        <button
          type="button"
          data-testid="user-delete"
          disabled={pending === user.id || user.id === currentUserId}
          title={
            user.id === currentUserId
              ? 'You cannot delete the account you are signed in as'
              : `Delete ${user.email}`
          }
          onClick={() => void remove(user)}
          className="rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Delete
        </button>
      ),
    },
  ];

  return (
    <div data-testid="users-admin" className="space-y-4">
      {error ? (
        <p
          data-testid="users-error"
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          data-testid="users-notice"
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {notice}
        </p>
      ) : null}

      <Card testId="users-table-card">
        <CardHeader
          title="Users"
          hint="Role and status are enforced by the API; members see only the work they created."
        />
        <CardBody>
          <Table
            columns={columns}
            rows={users}
            rowKey={(user) => user.id}
            testId="users-table"
            rowTestId="user-row"
            empty={<EmptyState testId="users-empty" title="No users yet" />}
          />
        </CardBody>
      </Card>

      <Card testId="users-create-card">
        <CardHeader title="Create user" hint="The new account can sign in immediately." />
        <CardBody>
          <form
            data-testid="user-create-form"
            onSubmit={(event) => void create(event)}
            className="grid gap-3 sm:grid-cols-2"
          >
            <label className="text-xs text-slate-600">
              Email
              <input
                data-testid="user-create-email"
                type="email"
                required
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                className={field}
              />
            </label>
            <label className="text-xs text-slate-600">
              Username
              <input
                data-testid="user-create-username"
                required
                minLength={2}
                maxLength={39}
                pattern="[a-z0-9][a-z0-9_-]{1,38}"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                className={field}
              />
            </label>
            <label className="text-xs text-slate-600">
              Name (optional)
              <input
                data-testid="user-create-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={field}
              />
            </label>
            <label className="text-xs text-slate-600">
              Role
              <select
                data-testid="user-create-role"
                value={form.role}
                onChange={(event) =>
                  setForm({ ...form, role: event.target.value as UserRole })
                }
                className={field}
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <label className="text-xs text-slate-600 sm:col-span-2">
              Password (at least 8 characters)
              <input
                data-testid="user-create-password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                className={field}
              />
            </label>
            <div className="sm:col-span-2">
              <button
                type="submit"
                data-testid="user-create-submit"
                disabled={creating}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-60"
              >
                {creating ? 'Creating…' : 'Create user'}
              </button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
