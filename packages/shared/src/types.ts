/**
 * @vin/shared — VIN domain types
 *
 * Core rules used by every layer (API, web, workers):
 *  1. A VIN has an event CHAIN. Old events are never overwritten.
 *  2. Vehicle money is never a volatile token. Stablecoin or fiat only.
 *  3. The NFT is a RECEIPT and a CLAIM TRAIL. It is not a vehicle title.
 *  4. The platform token is for COLLATERAL and ACCESS. It does not buy vehicle
 *     prices, pay revenue share, or grant governance over the company.
 */

// ---------------------------------------------------------------------------
// Actors and roles
// ---------------------------------------------------------------------------

export const ROLES = ['buyer', 'seller', 'inspector', 'curator', 'arbiter'] as const;
export type Role = (typeof ROLES)[number];

export const VERIFICATION_LEVELS = ['none', 'basic', 'business_verified', 'suspended'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** One account holds one role (concept §3 "account opening separates roles"). */
export interface Actor {
  id: string;
  role: Role;
  displayName: string;
  email: string;
  /** Solana wallet (base58) — the PAYOUT address, not an exchange account. */
  walletAddress: string | null;
  /**
   * Payout destination. Always paid in stablecoin or fiat. Holding the token is
   * never a condition for getting paid.
   */
  payoutAddress: string | null;
  verification: VerificationLevel;
  /** For inspectors: coverage area and base location. */
  countryCode: string;
  city: string | null;
  baseCurrency: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// VIN
// ---------------------------------------------------------------------------

/**
 * The VIN used on the platform is not the official registration VIN. Two
 * countries can use different chassis formats, so uniqueness inside the
 * platform does not mean uniqueness in official registries. Every vehicle page
 * must show this notice (see `vinScopeNotice()`).
 */
export interface VinRecord {
  vin: string;
  make: string;
  model: string;
  year: number;
  originCountry: string;
  platformUnique: true;
}

export function vinScopeNotice(): string {
  return (
    'A VIN is unique only inside the VIN platform. Chassis formats differ between countries, ' +
    'and on-chain uniqueness is not the same as uniqueness in official registries. ' +
    'This record is a claim and transaction trail, not a title.'
  );
}

// ---------------------------------------------------------------------------
// Events — the source of truth
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'listing_created',
  'listing_updated',
  'deal_committed',
  'report_uploaded',
  'odometer_anomaly',
  'inspection_funds_released',
  'vehicle_funds_released',
  'note_completed',
  'dispute_opened',
  'dispute_resolved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Categories for filtering feeds, not a replacement for events. */
export const EVENT_CATEGORIES = ['agreement', 'inspection', 'funds', 'note', 'dispute'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_META: Record<EventType, { label: string; category: EventCategory }> = {
  listing_created: { label: 'Listing created', category: 'agreement' },
  listing_updated: { label: 'Listing updated before a buyer committed', category: 'agreement' },
  deal_committed: { label: 'Deal locked (funds entered escrow)', category: 'agreement' },
  report_uploaded: { label: 'Inspection report uploaded', category: 'inspection' },
  odometer_anomaly: { label: 'Odometer anomaly', category: 'inspection' },
  inspection_funds_released: { label: 'Inspection funds released to the workshop', category: 'funds' },
  vehicle_funds_released: { label: 'Vehicle funds released to the seller', category: 'funds' },
  note_completed: { label: 'Completion receipt recorded', category: 'note' },
  dispute_opened: { label: 'Dispute opened', category: 'dispute' },
  dispute_resolved: { label: 'Dispute resolved', category: 'dispute' },
};

/**
 * Only HASHES are ever anchored on-chain. Raw files (photos, report PDFs) stay
 * off-chain.
 */
export interface EventPayload {
  // listing
  make?: string;
  model?: string;
  year?: number;
  priceAmount?: string;
  /** Free-form currency code (USDC, AED, USD, ...). Vehicle money is stablecoin or fiat only. */
  priceCurrency?: string;
  shippingTerms?: string;
  photoHashes?: string[];
  // deal
  dealId?: string;
  buyerId?: string;
  selectedInspectorId?: string;
  inspectionFeeAmount?: string;
  inspectionFeeCurrency?: string;
  inspectionDeadline?: string;
  escrowRef?: string;
  // inspection
  odometerKm?: number;
  inspectedAt?: string;
  inspectorId?: string;
  reportHash?: string;
  dashboardPhotoHash?: string;
  reportStandardVersion?: string;
  anomaly?: {
    previousOdometerKm: number;
    previousEventId: string;
    deltaKm: number;
  };
  // funds
  amount?: string;
  currency?: string;
  platformFeeAmount?: string;
  recipientId?: string;
  payoutRef?: string;
  // receipt
  /** Null while the receipt NFT has not really been minted. No claims before the asset exists. */
  noteAssetId?: string | null;
  noteMintAddress?: string | null;
  noteMetadataUri?: string;
  evidenceRoot?: string;
  escrowTxId?: string;
  // dispute
  disputeId?: string;
  reason?: string;
  outcome?: DisputeOutcome;
  bondSlashedAmount?: string;
  refundedAmount?: string;
  releasedAmount?: string;
  arbiterNote?: string;
}

export const DISPUTE_OUTCOMES = [
  'refund_buyer',
  'release_to_seller',
  'split',
  'bond_slashed',
] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export interface VinEvent {
  id: string;
  vin: string;
  seq: number;
  type: EventType;
  category: EventCategory;
  /** JOIN to a deal, to separate event chains per transaction. */
  dealId: string | null;
  payload: EventPayload;
  /** Solana slot/signature where the hash was anchored (optional, after the publication stage). */
  anchorSignature: string | null;
  /** Who triggered it. Always an actor, never an unattributed "system". */
  actorId: string | null;
  actorRole: Role | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Listings and deals
// ---------------------------------------------------------------------------

export const LISTING_STATUSES = ['draft', 'listed', 'reserved', 'completed', 'cancelled', 'disputed'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const DEAL_STATES = [
  'draft',
  'escrow_pending',
  'inspecting',
  'inspection_accepted',
  'handover_pending',
  'completed',
  'frozen',
  'cancelled',
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export interface Listing {
  id: string;
  vin: string;
  sellerId: string;
  make: string;
  model: string;
  year: number;
  odometerKm: number | null;
  location: string;
  priceAmount: string;
  priceCurrency: 'USDC' | 'AED' | 'USD';
  shippingTerms: string;
  photoHashes: string[];
  status: ListingStatus;
  bondAmount: string;
  bondCurrency: 'VIN' | 'USDC';
  createdAt: string;
  updatedAt: string;
}

export interface InspectionReport {
  id: string;
  dealId: string;
  vin: string;
  inspectorId: string;
  odometerKm: number;
  inspectedAt: string;
  /** Raw file stays off-chain; only the hash is anchored. */
  reportHash: string;
  dashboardPhotoHash: string;
  conditionSummary: string;
  standardVersion: string;
  anomaly: boolean;
}

export interface Deal {
  id: string;
  listingId: string;
  vin: string;
  buyerId: string;
  sellerId: string;
  inspectorId: string;
  state: DealState;
  priceAmount: string;
  priceCurrency: string;
  shippingPaidBy: 'buyer' | 'seller';
  shippingAmount: string;
  inspectionFeeAmount: string;
  /** Vehicle escrow and inspection escrow are separate legs. */
  escrowRefVehicle: string | null;
  escrowRefInspection: string | null;
  /** Inspection funds release only after a complete report the buyer accepted. */
  inspectionReleasedAt: string | null;
  /** Vehicle funds release only after handover conditions are met. */
  vehicleReleasedAt: string | null;
  inspectionDeadline: string;
  handoverTerms: string;
  handoverConfirmedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Dispute {
  id: string;
  dealId: string;
  openedBy: string;
  reason: string;
  state: 'open' | 'resolved';
  outcome: DisputeOutcome | null;
  arbiterId: string | null;
  bondSlashedAmount: string | null;
  refundedAmount: string | null;
  releasedAmount: string | null;
  arbiterNote: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface Bond {
  id: string;
  actorId: string;
  purpose: 'listing' | 'inspection_capacity';
  amount: string;
  currency: 'VIN' | 'USDC';
  state: 'locked' | 'returned' | 'slashed';
  listingId: string | null;
  lockedAt: string;
  settledAt: string | null;
  reason: string | null;
}

export interface ReputationSnapshot {
  actorId: string;
  role: Role;
  dealsCompleted: number;
  disputesOpened: number;
  disputesLost: number;
  onTimeReportRate: number | null;
  standardComplianceRate: number | null;
  medianReportHours: number | null;
  listedInRanking: boolean;
  lastComputedAt: string;
}

// ---------------------------------------------------------------------------
// Escrow (provider abstraction — PSP/custodian in the MVP, Anchor at scale)
// ---------------------------------------------------------------------------

export const ESCROW_LEGS = ['vehicle', 'inspection'] as const;
export type EscrowLeg = (typeof ESCROW_LEGS)[number];

export type EscrowProviderKind = 'mock' | 'anchor_solana' | 'licensed_custodian';

export const ESCROW_STATUSES = [
  'pending',
  'funded',
  'frozen',
  'released',
  'refunded',
  'partially_released',
  'slashed',
] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export interface ReleaseTerms {
  vehicle: ('handover_location_confirmed' | 'load_proof' | 'mutual_confirmation')[];
  inspection: ('report_uploaded' | 'buyer_accepted' | 'deadline_elapsed')[];
}

export interface Escrow {
  id: string;
  dealId: string;
  leg: EscrowLeg;
  provider: EscrowProviderKind;
  amount: string;
  currency: string;
  status: EscrowStatus;
  releaseTerms: ReleaseTerms;
  fundedAt: string | null;
  releasedAt: string | null;
  txRef: string | null;
}

// ---------------------------------------------------------------------------
// Token: collateral and access. No other function.
// ---------------------------------------------------------------------------

export interface TokenUtility {
  /** Three token functions — and only these three. */
  functions: readonly ['listing_bond', 'fee_discount', 'capacity_access'];
  neverDoes: readonly ['buys_vehicle_price', 'revenue_share', 'company_governance'];
}

export const TOKEN_UTILITY: TokenUtility = {
  functions: ['listing_bond', 'fee_discount', 'capacity_access'],
  neverDoes: ['buys_vehicle_price', 'revenue_share', 'company_governance'],
};

// ---------------------------------------------------------------------------
// Corridors (the first corridor is deliberately narrow)
// ---------------------------------------------------------------------------

export interface Corridor {
  id: string;
  originCountry: string;
  destinationCountry: string;
  minVehiclePriceUsd: number;
  mandatoryInspection: true;
  allowedCurrencies: string[];
  status: 'pilot' | 'active' | 'paused';
  openedAt: string;
}

export interface CorridorMetrics {
  corridorId: string;
  dealsCompleted: number;
  disputeRate: number;
  medianHoursToReport: number | null;
  unexplainedOdometerAnomalies: number;
  sellerReturnRate: number;
  inspectorReturnRate: number;
  /** Expansion halt trigger (playbook §10). */
  expansionHalted: boolean;
  haltReasons: string[];
}

// ---------------------------------------------------------------------------
// API DTOs
// ---------------------------------------------------------------------------

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INSPECTOR_CONFLICT: 'INSPECTOR_CONFLICT',
  BOND_REQUIRED: 'BOND_REQUIRED',
  LISTING_ALREADY_RESERVED: 'LISTING_ALREADY_RESERVED',
  DEADLINE_PASSED: 'DEADLINE_PASSED',
  DEAL_FROZEN: 'DEAL_FROZEN',
  CORRIDOR_NOT_SERVED: 'CORRIDOR_NOT_SERVED',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
