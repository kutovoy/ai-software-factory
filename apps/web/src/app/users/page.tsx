import { ComingSoon } from '@/components/ui/ComingSoon';

export const dynamic = 'force-dynamic';

export default function UsersPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-6 py-6">
      <header>
        <h1 className="text-lg font-semibold text-slate-900">Users</h1>
        <p className="text-sm text-slate-500">Today there is a single implicit local user.</p>
      </header>
      <ComingSoon
        title="Users"
        phase="Phase 6 — team & cloud"
        description="Team membership, per-gate approver lists, roles and audit of who approved what."
        bullets={[
          'Gate approvals are attributed to a user once auth exists',
          'The inbox becomes personal per user, not per deployment',
          'Auth, orgs and quotas are out of scope for Phase 2b',
        ]}
      />
    </div>
  );
}
