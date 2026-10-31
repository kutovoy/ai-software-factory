import { NewChat } from '@/components/chat/NewChat';
import { safeGet } from '@/lib/api';
import type { FactoryDetail, FactoryListItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ factory?: string }>;
}) {
  const { factory } = await searchParams;
  const list = await safeGet<{ factories: FactoryListItem[] }>('/factories', { factories: [] });
  const selected = factory ?? list.factories[0]?.name ?? 'example';

  const detail = await safeGet<{ factory: FactoryDetail } | null>(
    `/factories/${encodeURIComponent(selected)}`,
    null,
  );

  const manifest = detail?.factory.manifest;
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
            Talking to <span className="font-mono">{selected}</span> through the same adapter + runner
            pipeline factory runs use.
          </p>
        </div>
      </header>

      <NewChat factory={selected} defaultHarness={defaultHarness} defaultModel={defaultModel} />
    </div>
  );
}
