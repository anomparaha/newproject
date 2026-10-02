/**
 * State machine deal VIN.
 *
 * Yang menentukan perpindahan status hanyalah EVENT, bukan update kolom diam-diam.
 * Semua fungsi di modul ini murni (pure) supaya bisa dipakai backend, frontend,
 * maupun pengujian tanpa basis data.
 */

import type { DealState, EventType } from './types.js';

export type DealAction =
  | 'seller_listed'
  | 'buyer_commits_and_funds'
  | 'escrow_funded'
  | 'inspector_uploads_report'
  | 'buyer_accepts_report'
  | 'deadline_elapsed'
  | 'handover_confirmed'
  | 'vehicle_released'
  | 'open_dispute'
  | 'arbiter_resolves_refund'
  | 'arbiter_resolves_release'
  | 'cancel_before_funding';

interface TransitionRule {
  from: DealState[];
  to: DealState;
  actor: 'seller' | 'buyer' | 'inspector' | 'platform' | 'arbiter';
}

export const DEAL_TRANSITIONS: Record<DealAction, TransitionRule> = {
  seller_listed: { from: ['draft'], to: 'draft', actor: 'seller' },
  buyer_commits_and_funds: { from: ['draft'], to: 'escrow_pending', actor: 'buyer' },
  escrow_funded: { from: ['escrow_pending'], to: 'inspecting', actor: 'platform' },
  inspector_uploads_report: { from: ['inspecting'], to: 'inspecting', actor: 'inspector' },
  buyer_accepts_report: { from: ['inspecting'], to: 'inspection_accepted', actor: 'buyer' },
  // Sesuai konsep §3: bila laporan tidak diterima/ditolak dalam batas waktu,
  // dana inspeksi tetap boleh lepas bila laporan memenuhi standar.
  deadline_elapsed: { from: ['inspecting'], to: 'inspection_accepted', actor: 'platform' },
  handover_confirmed: { from: ['inspection_accepted'], to: 'handover_pending', actor: 'buyer' },
  vehicle_released: { from: ['handover_pending'], to: 'completed', actor: 'platform' },
  open_dispute: {
    from: ['escrow_pending', 'inspecting', 'inspection_accepted', 'handover_pending'],
    to: 'frozen',
    actor: 'buyer',
  },
  arbiter_resolves_refund: { from: ['frozen'], to: 'cancelled', actor: 'arbiter' },
  arbiter_resolves_release: { from: ['frozen'], to: 'completed', actor: 'arbiter' },
  cancel_before_funding: { from: ['escrow_pending'], to: 'cancelled', actor: 'platform' },
};

export interface TransitionCheck {
  ok: boolean;
  state: DealState;
  reason?: string;
}

export function canTransition(current: DealState, action: DealAction): TransitionCheck {
  const rule = DEAL_TRANSITIONS[action];
  if (!rule) {
    return { ok: false, state: current, reason: `Aksi tidak dikenal: ${action}` };
  }
  if (current === 'frozen' && action !== 'arbiter_resolves_refund' && action !== 'arbiter_resolves_release') {
    return {
      ok: false,
      state: current,
      reason: 'Escrow dan nota dibekukan. Keputusan arbitrase diperlukan sebelum langkah lain.',
    };
  }
  if (rule.from.includes(current)) {
    return { ok: true, state: rule.to, reason: undefined };
  }
  return {
    ok: false,
    state: current,
    reason: `Tidak bisa "${action}" dari status ${current}.`,
  };
}

/** Event yang WAJIB ada agar dana kendaraan boleh cair (kontrol §10). */
export function vehicleReleasePreconditions(input: {
  handoverTerms: string;
  confirmedBy: string[];
  buyerId: string;
  sellerId: string;
  disputeOpen: boolean;
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (input.disputeOpen) missing.push('sengketa_masih_terbuka');
  if (input.confirmedBy.length === 0) {
    missing.push('syarat_serah_terima_belum_terkonfirmasi');
  }
  const needsBoth = input.handoverTerms.toLowerCase().includes('konfirmasi kedua pihak');
  if (needsBoth) {
    if (!input.confirmedBy.includes(input.buyerId)) missing.push('konfirmasi_pembeli');
    if (!input.confirmedBy.includes(input.sellerId)) missing.push('konfirmasi_penjual');
  }
  return { ok: missing.length === 0, missing };
}

/** Event yang WAJIB ada agar dana inspeksi boleh cair. */
export function inspectionReleasePreconditions(input: {
  reportUploaded: boolean;
  reportMeetsStandard: boolean;
  buyerAccepted: boolean;
  deadlineElapsed: boolean;
}): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!input.reportUploaded) missing.push('laporan_belum_diunggah');
  if (!input.reportMeetsStandard) missing.push('laporan_tidak_memenuhi_standar');
  if (!input.buyerAccepted && !input.deadlineElapsed) {
    missing.push('pembeli_belum_menerima_dan_batas_waktu_belum_lewat');
  }
  return { ok: missing.length === 0, missing };
}

/** Anomali kilometer tidak pernah otomatis menolak - hanya peringatan. */
export function odometerIsAnomaly(currentKm: number, previousKm: number | null): boolean {
  if (previousKm === null) return false;
  return currentKm < previousKm;
}

export function eventForAction(action: DealAction): EventType | null {
  switch (action) {
    case 'buyer_commits_and_funds':
      return 'deal_committed';
    case 'inspector_uploads_report':
      return 'report_uploaded';
    case 'buyer_accepts_report':
      return 'inspeksi_dana_lepas';
    case 'vehicle_released':
      return 'kendaraan_dana_lepas';
    case 'open_dispute':
      return 'dispute_opened';
    case 'arbiter_resolves_refund':
    case 'arbiter_resolves_release':
      return 'dispute_resolved';
    default:
      return null;
  }
}

export const DEAL_STATE_LABEL: Record<DealState, string> = {
  draft: 'Draft - listing tayang, belum ada pembeli',
  escrow_pending: 'Escrow menunggu pendanaan',
  inspecting: 'Inspeksi berjalan',
  inspection_accepted: 'Laporan diterima, menunggu serah terima',
  handover_pending: 'Serah terima dikonfirmasi, menunggu pelepasan dana',
  completed: 'Selesai - nota tercatat',
  frozen: 'Dibekukan - sengketa berjalan',
  cancelled: 'Dibatalkan',
};
