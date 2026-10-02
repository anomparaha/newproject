/**
 * Abstraksi escrow.
 *
 * Kontrak yang tidak boleh dilanggar implementasi mana pun:
 *  - Dana kendaraan dan dana inspeksi BERBEDA escrow (leg terpisah).
 *  - Dana kendaraan hanya lepas setelah syarat serah terima terpenuhi.
 *  - Dana inspeksi hanya lepas setelah laporan lengkap & memenuhi standar.
 *  - Sengketa membekukan escrow dan nota.
 *
 * Urutan implementasi yang direkomendasikan:
 *  MVP   -> MockEscrowProvider + penyedia pembayaran berizin (rekening bersama/PJP)
 *  Skala -> AnchorEscrowProvider (program Solana, vault PDA, USDC) untuk dana
 *           lintas negara + penyedia fiat berizin untuk on/off-ramp lokal.
 */

import type { Escrow, EscrowLeg, EscrowProviderKind, EscrowStatus, ReleaseTerms } from './types.js';

export interface FundResult {
  escrowId: string;
  status: EscrowStatus;
  txRef: string;
  fundedAt: string;
}

export interface ReleaseResult {
  escrowId: string;
  status: EscrowStatus;
  txRef: string;
  releasedAt: string;
}

export interface EscrowProvider {
  readonly kind: EscrowProviderKind;
  createEscrow(input: {
    dealId: string;
    leg: EscrowLeg;
    amount: string;
    currency: string;
    releaseTerms: ReleaseTerms;
  }): Promise<Escrow>;
  fund(escrowId: string, payerRef: string): Promise<FundResult>;
  /** Pelepasan hanya boleh dijalankan setelah semua syarat terbukti di event log. */
  release(escrowId: string, opts: { recipientRef: string; evidenceEventIds: string[] }): Promise<ReleaseResult>;
  freeze(escrowId: string, reason: string): Promise<{ escrowId: string; status: EscrowStatus; txRef: string }>;
  /** Potongan jaminan masuk KAS SENGKETA, bukan dompet tim. */
  slash(escrowId: string, amount: string, rateToDisputeFundBps: number): Promise<ReleaseResult>;
  refund(escrowId: string, reason: string): Promise<ReleaseResult>;
  /** Putusan arbitrase "split": sebagian kembali ke pembeli, sebagian ke penjual. */
  partialRelease(
    escrowId: string,
    parts: { toBuyer: string; toSeller: string },
    evidenceEventIds: string[],
  ): Promise<ReleaseResult & { toBuyer: string; toSeller: string }>;
}

export function sameCurrency(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Default syarat pelepasan per leg, dipakai saat deal dikunci. */
export function defaultReleaseTerms(input: {
  handoverTerms: string;
}): ReleaseTerms {
  const terms = input.handoverTerms.toLowerCase();
  const vehicle: ReleaseTerms['vehicle'] = [];
  if (terms.includes('lokasi') || terms.includes('serah di')) vehicle.push('handover_location_confirmed');
  if (terms.includes('muat') || terms.includes('load')) vehicle.push('load_proof');
  if (vehicle.length === 0) vehicle.push('mutual_confirmation');
  return {
    vehicle,
    inspection: ['report_uploaded', 'buyer_accepted'],
  };
}
