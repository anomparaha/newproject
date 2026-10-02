/**
 * Escrow abstraction.
 *
 * Contract that every implementation must honour:
 *  - Vehicle funds and inspection funds live in SEPARATE escrows (legs).
 *  - Vehicle funds release only after handover conditions are met.
 *  - Inspection funds release only after a complete report that meets the standard.
 *  - A dispute freezes both the escrow and the receipt.
 *
 * Recommended implementation order:
 *  MVP   -> MockEscrowProvider plus a licensed payment provider (escrow account/PSP)
 *  Scale -> AnchorEscrowProvider (Solana program, PDA vault, USDC) for cross-border
 *           funds, plus a licensed fiat provider for local on/off-ramp.
 */

import type {
  DisputeOutcome,
  Escrow,
  EscrowLeg,
  EscrowProviderKind,
  EscrowStatus,
  ReleaseTerms,
} from './types.js';

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
  /** Release may only run once every condition is proven in the event log. */
  release(escrowId: string, opts: { recipientRef: string; evidenceEventIds: string[] }): Promise<ReleaseResult>;
  freeze(escrowId: string, reason: string): Promise<{ escrowId: string; status: EscrowStatus; txRef: string }>;
  /** A slashed bond goes to the DISPUTE FUND, never to the team wallet. */
  slash(escrowId: string, amount: string, rateToDisputeFundBps: number): Promise<ReleaseResult>;
  refund(escrowId: string, reason: string): Promise<ReleaseResult>;
  /** "Split" arbitration award: part back to the buyer, part to the seller. */
  partialRelease(
    escrowId: string,
    parts: { toBuyer: string; toSeller: string },
    evidenceEventIds: string[],
  ): Promise<ReleaseResult & { toBuyer: string; toSeller: string }>;

  /**
   * Funds movement BASED ON AN ARBITRATION AWARD.
   *
   * This is the only path allowed to move money out of a frozen escrow, and only
   * after the arbiter has ruled. In the Anchor program its counterpart is
   * `resolve_dispute`, which transfers from the frozen vault.
   *
   * `toCounterparty` is the seller (vehicle leg) or the workshop (inspection
   * leg). Whatever is not paid to the counterparty goes back to the buyer, so no
   * funds are ever left stranded.
   */
  resolveByArbitration(
    escrowId: string,
    input: {
      decision: DisputeOutcome;
      toBuyer: string;
      toCounterparty: string;
      evidenceEventIds: string[];
    },
  ): Promise<ReleaseResult & { toBuyer: string; toCounterparty: string }>;
}

export function sameCurrency(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** Default release terms per leg, used when a deal is locked. */
export function defaultReleaseTerms(input: {
  handoverTerms: string;
}): ReleaseTerms {
  const terms = input.handoverTerms.toLowerCase();
  const vehicle: ReleaseTerms['vehicle'] = [];
  if (terms.includes('location') || terms.includes('handover at')) vehicle.push('handover_location_confirmed');
  if (terms.includes('load') || terms.includes('cargo')) vehicle.push('load_proof');
  if (vehicle.length === 0) vehicle.push('mutual_confirmation');
  return {
    vehicle,
    inspection: ['report_uploaded', 'buyer_accepted'],
  };
}
