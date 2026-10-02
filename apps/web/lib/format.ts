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
  return new Intl.DateTimeFormat('id-ID', {
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
    return `${minutes} menit lalu`;
  }
  if (Math.abs(hours) < 48) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export const ROLE_LABEL: Record<string, string> = {
  buyer: 'Pembeli',
  seller: 'Penjual / Dealer',
  inspector: 'Bengkel Inspeksi',
  curator: 'Kurator Koridor',
  arbiter: 'Arbiter',
};

export const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  escrow_pending: 'Escrow menunggu dana',
  inspecting: 'Inspeksi berjalan',
  inspection_accepted: 'Laporan diterima',
  handover_pending: 'Menunggu pelepasan dana',
  completed: 'Selesai',
  frozen: 'Dibekukan (sengketa)',
  cancelled: 'Dibatalkan',
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
  kesepakatan: 'text-info border-info/40',
  inspeksi: 'text-signal border-signal/40',
  dana: 'text-safe border-safe/40',
  nota: 'text-paper border-ink-600',
  sengketa: 'text-alert border-alert/50',
};

export function randomSha256(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
