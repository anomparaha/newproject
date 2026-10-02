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
  draft: 'Draft',
  escrow_pending: 'Escrow awaiting funds',
  inspecting: 'Inspection in progress',
  inspection_accepted: 'Report accepted',
  handover_pending: 'Waiting for fund release',
  completed: 'Completed',
  frozen: 'Frozen (dispute)',
  cancelled: 'Cancelled',
};

export const STATE_TONE: Record<string, string> = {
  escrow_pending: 'text-signal border-signal/40',
  inspecting: 'text-info border-info/40',
  inspection_accepted: 'text-safe border-safe/40',
  handover_pending: 'text-signal border-signal/40',
  completed: 'text-safe border-safe/40',
  frozen: 'text-alert border-alert/50',
  cancelled: 'text-mist-400',
  draft: 'text-mist-300',
};

export const CATEGORY_TONE: Record<string, string> = {
  agreement: 'text-info border-info/40',
  inspection: 'text-signal border-signal/40',
  funds: 'text-safe border-safe/40',
  note: 'text-paper border-ink-600',
  dispute: 'text-alert border-alert/50',
};

export function randomSha256(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
