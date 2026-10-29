import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  danger: 'bg-red-50 text-red-700 ring-red-200',
  warning: 'bg-amber-50 text-amber-700 ring-amber-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function Badge({
  children,
  tone = 'neutral',
  testId,
  mono = false,
}: {
  children: ReactNode;
  tone?: Tone;
  testId?: string;
  mono?: boolean;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        TONES[tone]
      } ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}
