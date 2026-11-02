import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in — Software Factory',
  description: 'Sign in to the Software Factory console.',
};

/** Full-page sign-in (spec `console-auth` › Sign-in and sessions). */
export default function LoginPage() {
  return (
    <div
      data-testid="login-page"
      className="flex min-h-screen items-center justify-center px-6 py-12"
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Software Factory
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Use the account issued by your operator.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          The compose demo bootstraps the admin from{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">FACTORY_ADMIN_EMAIL</code> /{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5">FACTORY_ADMIN_PASSWORD</code>. See{' '}
          <a className="underline hover:text-slate-700" href="/help/api">
            the API reference
          </a>{' '}
          for the public routes.
        </p>
      </div>
    </div>
  );
}
