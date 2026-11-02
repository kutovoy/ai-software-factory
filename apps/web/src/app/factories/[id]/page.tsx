import { redirect } from 'next/navigation';

/** `/factories/:id` lands on the dashboard (change `add-factory-identity`). */
export default async function FactoryIndexPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/factories/${encodeURIComponent(decodeURIComponent(id))}/dashboard`);
}
