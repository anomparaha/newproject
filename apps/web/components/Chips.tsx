import type { ReactNode } from 'react';
import { CATEGORY_TONE, STATE_LABEL, STATE_TONE, TONE, percent } from '@/lib/format';
import { Icon, type IconName } from '@/components/Icons';

export type Tone = keyof typeof TONE;

const DOT_BY_TONE: Record<string, string> = {
  [TONE.ok]: 'bg-emerald-600',
  [TONE.warn]: 'bg-amber-600',
  [TONE.bad]: 'bg-rose-600',
  [TONE.brand]: 'bg-emerald-400',
  [TONE.neutral]: 'bg-slate-500',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const toneClass = TONE[tone] ?? TONE.neutral;
  const dotColor = DOT_BY_TONE[toneClass] ?? 'bg-slate-400';
  return (
    <span className={`chip ${toneClass}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function StateChip({ state }: { state: string }) {
  const tone = STATE_TONE[state] ?? TONE.neutral;
  const dotColor = DOT_BY_TONE[tone] ?? 'bg-slate-400';
  return (
    <span className={`chip ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      <span>{STATE_LABEL[state] ?? state}</span>
    </span>
  );
}

export function CategoryChip({ category }: { category: string }) {
  const tone = CATEGORY_TONE[category] ?? TONE.neutral;
  return <span className={`chip capitalize ${tone}`}>{category}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-line pb-6">
      <div className="max-w-3xl space-y-2">
        {eyebrow ? (
          <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-brand-600">
            <span className="h-1 w-3 rounded-full bg-brand-600" />
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">{title}</h1>
        {description ? <p className="text-[0.95rem] leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function SectionTitle({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Label/value pair used inside <dl> grids. */
export function Fact({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}

export function Metric({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: IconName;
}) {
  return (
    <div className="card group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated hover:border-slate-300 bg-white">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-muted">{label}</div>
        {icon ? (
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-800 border border-slate-200 transition-colors group-hover:bg-slate-900 group-hover:text-white group-hover:border-slate-900 shadow-2xs">
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div className="mt-3 text-3xl font-extrabold tabular-nums tracking-tight text-ink">{value}</div>
      {hint ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
          <span>{hint}</span>
        </div>
      ) : null}
    </div>
  );
}

export function RateMetric({ label, value, hint, icon }: { label: string; value: number | null; hint?: string; icon?: IconName }) {
  return <Metric label={label} value={percent(value)} hint={hint} icon={icon} />;
}

const NOTICE_CONFIG: Record<
  'info' | 'warn' | 'danger' | 'safe',
  { icon: IconName; defaultTag: string; iconWrap: string; badgeTone: Tone }
> = {
  info: {
    icon: 'info',
    defaultTag: 'Protocol Rule',
    iconWrap: 'bg-slate-100 text-slate-800 border-slate-200',
    badgeTone: 'neutral',
  },
  warn: {
    icon: 'alert',
    defaultTag: 'Boundary Scope',
    iconWrap: 'bg-amber-100 text-amber-900 border-amber-200',
    badgeTone: 'warn',
  },
  danger: {
    icon: 'alert',
    defaultTag: 'Regulatory Alert',
    iconWrap: 'bg-rose-100 text-rose-900 border-rose-200',
    badgeTone: 'bad',
  },
  safe: {
    icon: 'check',
    defaultTag: 'Verified Status',
    iconWrap: 'bg-emerald-100 text-emerald-900 border-emerald-200',
    badgeTone: 'ok',
  },
};

export function Notice({
  tone = 'info',
  title,
  tag,
  children,
  className = '',
}: {
  tone?: 'info' | 'warn' | 'danger' | 'safe';
  title: string;
  tag?: string;
  children?: ReactNode;
  className?: string;
}) {
  const cfg = NOTICE_CONFIG[tone] ?? NOTICE_CONFIG.info;
  const displayTag = tag ?? cfg.defaultTag;

  // Single-line alert when no body content is present
  if (!children) {
    return (
      <div
        className={`flex items-center justify-between gap-3 rounded-2xl border border-slate-300 bg-white px-4 py-3 shadow-xs ${className}`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl border text-sm font-semibold shadow-2xs ${cfg.iconWrap}`}
          >
            <Icon name={cfg.icon} className="h-4 w-4" />
          </span>
          <span className="text-sm font-bold text-ink truncate">{title}</span>
        </div>
        <Badge tone={cfg.badgeTone}>{displayTag}</Badge>
      </div>
    );
  }

  // Structured disclosure card with spacious header and full-width title
  return (
    <div
      className={`card group flex flex-col justify-between rounded-2xl border border-slate-300 bg-white p-6 shadow-xs transition-all duration-200 hover:border-slate-400 hover:shadow-elevated ${className}`}
    >
      <div>
        {/* Top row: Icon badge on left, Status chip on right */}
        <div className="flex items-center justify-between gap-3">
          <span
            className={`grid h-9 w-9 place-items-center rounded-xl border text-sm font-semibold shadow-2xs ${cfg.iconWrap}`}
          >
            <Icon name={cfg.icon} className="h-4 w-4" />
          </span>
          <Badge tone={cfg.badgeTone}>{displayTag}</Badge>
        </div>

        {/* Unconstrained full-width title */}
        <h3 className="mt-4 text-base font-bold tracking-tight text-ink">{title}</h3>

        {/* High-contrast readable body text */}
        <div className="mt-2.5 text-sm leading-relaxed text-body">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-white/70 px-6 py-14 text-center backdrop-blur-xs">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-subtle text-muted">
        <Icon name="search" className="h-6 w-6" />
      </div>
      <div className="text-base font-semibold text-ink">{title}</div>
      {children ? <div className="mx-auto mt-1 max-w-sm text-sm text-muted">{children}</div> : null}
    </div>
  );
}
