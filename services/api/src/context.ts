import type { DatabaseSync } from 'node:sqlite';
import type { MockEscrowProvider } from './escrow.js';

export interface AppContext {
  db: DatabaseSync;
  escrow: MockEscrowProvider;
}

/**
 * Autentikasi demo memakai header `x-actor-id`.
 *
 * PRODUKSI: ganti dengan Sign-In With Solana (SIWS) + verifikasi attestation.
 * Model yang direkomendasikan:
 *  - Dompet Solana sebagai identitas (challenge nonce ditandatangani).
 *  - Verifikasi identitas usaha (KYB) penjual/bengkel diterbitkan sebagai
 *    attestation (mis. Solana Attestation Service / penjual attestation berizin),
 *    bukan disimpan sebagai kolom biasa.
 *  - Pembeli: verifikasi dasar cukup sebelum membayar.
 * Header x-actor-id TIDAK boleh dipakai di produksi.
 */
export function actorIdFromRequest(headerValue: string | undefined): string | null {
  return headerValue && headerValue.trim().length > 0 ? headerValue.trim() : null;
}

/**
 * Waktu simulasi KHUSUS DATA DEMO.
 *
 * Data demo yang di-seed dalam hitungan detik membuat metrik waktu (mis. median
 * waktu sampai laporan) selalu 0 jam. Header `x-demo-backdate-hours` menggeser
 * waktu event supaya metrik demo masuk akal. Header ini DIABAIKAN saat
 * VIN_DEMO_MODE=false, dan di produksi waktu event selalu waktu server.
 */
export function demoBackdate(headerValue: string | undefined, now: () => string): string | null {
  if (process.env.VIN_DEMO_MODE === 'false') return null;
  if (!headerValue) return null;
  const hours = Number(headerValue);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 180) return null;
  return new Date(Date.parse(now()) - hours * 3_600_000).toISOString();
}
