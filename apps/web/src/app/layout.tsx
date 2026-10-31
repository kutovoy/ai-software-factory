import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
// Swagger UI's stylesheet is global; App Router only allows global CSS in the root layout.
// Loaded after the Tailwind layers so the explorer's own rules win where they overlap.
import 'swagger-ui-react/swagger-ui.css';
import { ContextHelp } from '@/components/help/ContextHelp';
import { Sidebar } from '@/components/nav/Sidebar';
import { safeGet } from '@/lib/api';
import type { FactoryListItem } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Software Factory',
  description: 'The harness front-end: chat, runs, inbox and factory definitions.',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const factories = await safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] });

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900">
        <div className="flex min-h-screen">
          <Sidebar factories={factories.factories} />
          <div className="flex min-w-0 flex-1 flex-col">
            <ContextHelp />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
