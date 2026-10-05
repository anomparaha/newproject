export function formatAmount(amount: string | number | null | undefined, currency?: string): string {
  if (amount === null || amount === undefined) return '-';
  const raw = typeof amount === 'number' ? String(amount) : amount;
  const [whole = '0', frac = ''] = raw.split('.');
  const trimmed = frac.replace(/0+$/, '');
  const base = trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
  return currency ? `${base} ${currency}` : base;
}

export function shortHash(value: string | null | undefined, lead = 8, tail = 6): string {
  if (!value) return '-';
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(d);
}

export function relative(iso: string | null | undefined): string {
  if (!iso) return '-';
  const diff = Date.now() - Date.parse(iso);
  const hours = Math.round(diff / 3_600_000);
  if (Math.abs(hours) < 1) {
    const minutes = Math.round(diff / 60_000);
    return `${minutes} minutes ago`;
  }
  if (Math.abs(hours) < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export const ROLE_LABEL: Record<string, string> = {
  buyer: 'Buyer',
  seller: 'Seller / Dealer',
  inspector: 'Inspection Workshop',
  curator: 'Corridor Curator',
  arbiter: 'Arbiter',
};

export const STATE_LABEL: Record<string, string> = {
  listed: 'Available',
  reserved: 'Reserved',
  draft: 'Draft',
  escrow_pending: 'Escrow awaiting funds',
  inspecting: 'Inspection in progress',
  inspection_accepted: 'Report accepted',
  handover_pending: 'Waiting for fund release',
  completed: 'Completed',
  frozen: 'Frozen (dispute)',
  cancelled: 'Cancelled',
};

/** Tailwind classes for the status "pills" (border + background + text). */
export const TONE = {
  neutral: 'border-slate-300 bg-white text-slate-800 shadow-2xs',
  brand: 'border-slate-900 bg-slate-900 text-white font-semibold shadow-2xs',
  ok: 'border-emerald-300 bg-emerald-50 text-emerald-950 font-semibold shadow-2xs',
  warn: 'border-amber-300 bg-amber-50 text-amber-950 font-semibold shadow-2xs',
  bad: 'border-rose-300 bg-rose-50 text-rose-950 font-semibold shadow-2xs',
} as const;

export const STATE_TONE: Record<string, string> = {
  listed: TONE.ok,
  reserved: TONE.warn,
  escrow_pending: TONE.warn,
  inspecting: TONE.brand,
  inspection_accepted: TONE.ok,
  handover_pending: TONE.warn,
  completed: TONE.ok,
  frozen: TONE.bad,
  cancelled: TONE.neutral,
  draft: TONE.neutral,
};

export const CATEGORY_TONE: Record<string, string> = {
  agreement: TONE.brand,
  inspection: TONE.warn,
  funds: TONE.ok,
  note: TONE.neutral,
  dispute: TONE.bad,
};

export function randomSha256(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
