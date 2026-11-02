import Link from 'next/link';
import { EmptyState } from '@/components/ui/EmptyState';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <EmptyState
        testId="not-found"
        title="Not found"
        description="That run, factory or page does not exist."
        action={
          <Link
            href="/chat"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Back to New Chat
          </Link>
        }
      />
    </div>
  );
}
