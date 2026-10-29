import { redirect } from 'next/navigation';

/** The landing surface is New Chat — the harness front-end is the product's entry point. */
export default function HomePage() {
  redirect('/chat');
}
