import type { DatabaseSync } from 'node:sqlite';
import type { MockEscrowProvider } from './escrow.js';

export interface AppContext {
  db: DatabaseSync;
  escrow: MockEscrowProvider;
}

/**
 * Demo authentication uses the `x-actor-id` header.
 *
 * PRODUCTION: replace it with Sign-In With Solana (SIWS) plus attestation
 * verification. The recommended model:
 *  - A Solana wallet is the identity (a nonce challenge is signed).
 *  - Seller/workshop business verification (KYB) is issued as an attestation
 *    (e.g. Solana Attestation Service or a licensed attestation issuer),
 *    not stored as an ordinary column.
 *  - Buyers need only basic verification before paying.
 * The x-actor-id header must NEVER be used in production.
 */
export function actorIdFromRequest(headerValue: string | undefined): string | null {
  return headerValue && headerValue.trim().length > 0 ? headerValue.trim() : null;
}

/**
 * Simulated clock for DEMO DATA ONLY.
 *
 * Demo data seeded within seconds makes time-based metrics (e.g. median hours to
 * report) always read as 0 hours. The `x-demo-backdate-hours` header shifts
 * event timestamps so demo metrics make sense. It is IGNORED when
 * VIN_DEMO_MODE=false, and in production event time is always server time.
 */
export function demoBackdate(headerValue: string | undefined, now: () => string): string | null {
  if (process.env.VIN_DEMO_MODE === 'false') return null;
  if (!headerValue) return null;
  const hours = Number(headerValue);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 180) return null;
  return new Date(Date.parse(now()) - hours * 3_600_000).toISOString();
}
