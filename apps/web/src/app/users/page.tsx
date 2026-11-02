import { UsersAdmin } from '@/components/users/UsersAdmin';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getOrError } from '@/lib/api';
import { authRequired } from '@/lib/auth';
import type { UserWire } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Users (spec `console-auth` › User administration). Admin-only: the API answers `403
 * forbidden` for a member and `401 auth_required` without a session. The root layout
 * already redirects the latter, so a rendered error here is the member case.
 */
export default async function UsersPage() {
  const result = await getOrError<{ users: UserWire[] }>('/users');
  const forbidden = result.error?.status === 403 || result.error?.status === 401;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Users</h1>
        <p className="text-sm text-slate-500">
          Accounts, roles and status for the console and API. Admins manage users and see
          all work; members see only the items they created.
        </p>
      </header>

      {forbidden ? (
        <EmptyState
          testId="users-forbidden"
          title="Admin only"
          description={
            authRequired()
              ? 'Your account is signed in as a member. Ask an admin to change your role on this page.'
              : 'The API refused user management for this account.'
          }
        />
      ) : result.error ? (
        <Card testId="users-unavailable-card">
          <CardHeader title="Users unavailable" hint={result.error.code} />
          <CardBody>
            <EmptyState
              testId="users-unavailable"
              title="The API did not return the user list"
              description={result.error.message}
            />
          </CardBody>
        </Card>
      ) : (
        <UsersAdmin initialUsers={result.data?.users ?? []} />
      )}
    </div>
  );
}
