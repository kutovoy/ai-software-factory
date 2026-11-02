'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { safeNextPath } from '@/lib/auth';

/**
 * Sign-in form (spec `console-auth` › Sign-in and sessions). Posts to the console's
 * same-origin `/api/v1/auth/login` proxy, which forwards the API's HttpOnly
 * `factory_session` cookie to the browser. The page never holds or displays a credential.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      if (!response.ok) {
        if (body.code === 'invalid_credentials') {
          setError('Invalid email or password.');
        } else {
          setError(body.message ?? body.code ?? `sign-in failed (${response.status})`);
        }
        return;
      }
      router.replace(next ?? '/');
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  const field =
    'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200';

  return (
    <form
      data-testid="login-form"
      onSubmit={(event) => void submit(event)}
      className="space-y-4"
      aria-describedby={error ? 'login-error' : undefined}
    >
      <div>
        <label htmlFor="login-email" className="block text-xs font-medium text-slate-600">
          Email
        </label>
        <input
          id="login-email"
          data-testid="login-email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </div>

      <div>
        <label htmlFor="login-password" className="block text-xs font-medium text-slate-600">
          Password
        </label>
        <input
          id="login-password"
          data-testid="login-password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={field}
        />
      </div>

      {error ? (
        <p
          id="login-error"
          data-testid="login-error"
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        data-testid="login-submit"
        disabled={busy}
        className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-300 disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
