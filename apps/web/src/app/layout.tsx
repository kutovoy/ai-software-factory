import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
// Swagger UI's stylesheet is global; App Router only allows global CSS in the root layout.
// Loaded after the Tailwind layers so the explorer's own rules win where they overlap.
import 'swagger-ui-react/swagger-ui.css';
import { ContextHelp } from '@/components/help/ContextHelp';
import { Sidebar } from '@/components/nav/Sidebar';
import { safeGet } from '@/lib/api';
import { authRequired, isPublicPage } from '@/lib/auth';
import type { FactoryListItem, UserWire } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Software Factory',
  description: 'The harness front-end: chat, runs, inbox and factory definitions.',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  /**
   * Console auth gate (spec `console-auth` › Enforcement). The middleware already redirects
   * cookie-less page requests, but this server-side check is the authoritative one: it also
   * covers a stale/invalid cookie (the API answers 401, `safeGet` yields no user) and keeps
   * `/login` reachable, so there is no redirect loop. With `AUTH_REQUIRED` off the check is
   * skipped and the console keeps its implicit local user.
   */
  const requestHeaders = await headers();
  const pathname = requestHeaders.get('x-pathname') ?? '/';
  const authOn = authRequired();
  const session = authOn
    ? await safeGet<{ user: UserWire | null }>('/auth/me', { user: null })
    : { user: null };

  if (authOn && !session.user && !isPublicPage(pathname)) {
    redirect(`/login?next=${encodeURIComponent(pathname)}`);
  }

  // `/login` is a clean, full-page form: no sidebar, no contextual help.
  if (pathname === '/login') {
    return (
      <html lang="en">
        <body className="min-h-screen bg-slate-50 text-slate-900">{children}</body>
      </html>
    );
  }

  const [factories, cookieStore] = await Promise.all([
    safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] }),
    cookies(),
  ]);

  /**
   * Selected-factory persistence (`web-console` spec: "Stable factory selection"). The
   * cookie is written by the sidebar; a name that no longer exists is ignored rather than
   * shown as a phantom selection.
   */
  const raw = cookieStore.get('factory')?.value ?? null;
  let persisted: string | null = null;
  try {
    persisted = raw ? decodeURIComponent(raw) : null;
  } catch {
    persisted = null;
  }
  const initialFactory =
    persisted && factories.factories.some((factory) => factory.name === persisted) ? persisted : null;
  const forgejoEnabled = (process.env.FORGEJO_ENABLED ?? '1') !== '0';

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <div className="flex min-h-screen">
          <Sidebar
            factories={factories.factories}
            initialFactory={initialFactory}
            forgejoEnabled={forgejoEnabled}
            user={session.user}
            authRequired={authOn}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <ContextHelp />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
