import type { ReactNode } from 'react';
import { CATEGORY_TONE, STATE_LABEL, STATE_TONE, percent } from '@/lib/format';

export function StateChip({ state }: { state: string }) {
  const tone = STATE_TONE[state] ?? 'text-mist-300';
  return <span className={`chip ${tone}`}>{STATE_LABEL[state] ?? state}</span>;
}

export function CategoryChip({ category }: { category: string }) {
  const tone = CATEGORY_TONE[category] ?? 'text-mist-300';
  return <span className={`chip ${tone}`}>{category}</span>;
}

export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[0.68rem] uppercase tracking-wider text-mist-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-mist-400">{hint}</div> : null}
    </div>
  );
}

export function RateMetric({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return <Metric label={label} value={percent(value)} hint={hint} />;
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'safe';
  title: string;
  children?: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: 'border-info/30 bg-info/5 text-info',
    warn: 'border-signal/40 bg-signal/5 text-signal',
    danger: 'border-alert/40 bg-alert/5 text-alert',
    safe: 'border-safe/40 bg-safe/5 text-safe',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-sm font-medium">{title}</div>
      {children ? <div className="mt-1 text-xs text-mist-300">{children}</div> : null}
    </div>
  );
}
