import { redirect } from 'next/navigation';

export default async function FactoryIndexPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(`/factories/${encodeURIComponent(decodeURIComponent(name))}/dashboard`);
}
