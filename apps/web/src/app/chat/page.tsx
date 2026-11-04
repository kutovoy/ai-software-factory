import Link from 'next/link';
import { cookies } from 'next/headers';
import { NewChat } from '@/components/chat/NewChat';
import { EmptyState } from '@/components/ui/EmptyState';
import { getFactoryDetail, getFactoryList } from '@/lib/factories';

export const dynamic = 'force-dynamic';

/**
 * New Chat is a factory-scoped run (`POST /factories/:factoryId/chat`). `/chat` itself is a
 * global page (change `unify-factory-api`): the factory comes from the persisted `factory`
 * cookie, or the first factory the viewer owns — never a directory name and never a query
 * parameter (change `add-factory-identity`).
 */
export default async function ChatPage() {
  const [list, cookieStore] = await Promise.all([getFactoryList(), cookies()]);

  const known = new Set(list.factories.map((entry) => entry.id ?? entry.key));
  let persisted: string | null = null;
  try {
    const raw = cookieStore.get('factory')?.value ?? null;
    persisted = raw ? decodeURIComponent(raw) : null;
  } catch {
    persisted = null;
  }

  const selected =
    (persisted && known.has(persisted) ? persisted : null) ??
    list.factories[0]?.id ??
    list.factories[0]?.key ??
    null;

  if (!selected) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <EmptyState
          testId="chat-no-factory"
          title="No factory yet"
          description="A chat is a factory run, and factories are addressed by their id. Add a factory definition to git first."
          action={
            <Link
              href="/help/factories/add"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Add a factory
            </Link>
          }
        />
      </div>
    );
  }

  const detail = await getFactoryDetail(selected);

  const manifest = detail?.factory.manifest;
  const factoryName = detail?.factory.name ?? selected;
  const defaultHarness = manifest?.agentDefaults.harness?.type ?? 'opencode';
  // The API resolves `env:` model references (ADR-028); the composer must never show the
  // literal `env:FACTORY_MODEL` — an unresolved default stays empty for an explicit choice.
  const defaultModel = detail?.factory.defaultModel ?? '';

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">New Chat</h1>
          <p className="text-sm text-slate-500">
            Talking to <span className="font-mono">{factoryName}</span> through the same adapter +
            runner pipeline factory runs use.
          </p>
        </div>
      </header>

      <NewChat
        factoryId={selected}
        factoryName={factoryName}
        defaultHarness={defaultHarness}
        defaultModel={defaultModel}
      />
    </div>
  );
}
