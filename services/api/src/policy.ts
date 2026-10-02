/**
 * VIN platform policy.
 *
 * The numbers here are PRODUCT DECISIONS, to be read as operating parameters
 * rather than investment promises. Every threshold can be changed through
 * platform governance, and any change to corridor rules must be recorded as an
 * event.
 */

import type { Corridor, CorridorMetrics, TokenUtility } from '@vin/shared';
import { TOKEN_UTILITY } from '@vin/shared';

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

export const FEES = {
  /** Vehicle transaction fee. */
  vehicleBps: 100, // 1.00%
  /** Inspection app fee. */
  inspectionBps: 500, // 5.00% of the inspection fee
  /** Fee discount when paying with the platform token. */
  tokenDiscountFactor: 0.6,
  /** Burn only from fees that were actually collected from usage. */
  burnFromCollectedFeesOnly: true,
} as const;

// ---------------------------------------------------------------------------
// Bonds
// ---------------------------------------------------------------------------

export const BONDS = {
  /** Listing bond above the corridor value threshold. */
  listingBondUsdc: '50',
  /** Workshop bond required to take orders. */
  inspectorBondUsdc: '25',
  /** Value ceiling under which the bond may still be stablecoin (Proof Stage). */
  stablecoinAllowedBelowUsd: 30_000,
  /** Share of the bond slashed on a violation. Half goes to the dispute fund, not the team. */
  slashRatio: 0.5,
  disputeFundShare: 1.0,
} as const;

// ---------------------------------------------------------------------------
// Corridors
// ---------------------------------------------------------------------------

export const PILOT_CORRIDOR: Omit<Corridor, 'openedAt'> & { openedAt: string } = {
  id: 'cor_id_sg',
  originCountry: 'ID',
  destinationCountry: 'SG',
  minVehiclePriceUsd: 15_000,
  mandatoryInspection: true,
  allowedCurrencies: ['USDC', 'IDR'],
  status: 'pilot',
  openedAt: '2026-01-15T00:00:00.000Z',
};

/** Candidate corridors: not served until the pilot corridor is healthy. */
export const CANDIDATE_CORRIDORS = [
  { originCountry: 'ID', destinationCountry: 'MY', reason: 'Waiting for the pilot corridor to stabilise' },
  { originCountry: 'JP', destinationCountry: 'ID', reason: 'Japanese export: needs verified workshops in Japan' },
] as const;

// ---------------------------------------------------------------------------
// Capacity (token access, not purchases)
// ---------------------------------------------------------------------------

export const CAPACITY = {
  /** Active listing limit for a dealer without a capacity stake. */
  freeActiveListingsPerSeller: 3,
  /** Extra listing slots per capacity stake, never bought outright. */
  listingsPer1000Tokens: 5,
  /** Inspection queue: workshops with a capacity stake appear in the main queue. */
  priorityQueue: true,
} as const;

export const TOKEN: TokenUtility = TOKEN_UTILITY;

// ---------------------------------------------------------------------------
// Expansion halt triggers (playbook §10)
// ---------------------------------------------------------------------------

export const HALT_THRESHOLDS = {
  minDealsCompleted: 2,
  maxDisputeRate: 0.15,
  maxUnexplainedAnomalies: 3,
  minSellerReturnRate: 0.3,
  minInspectorReturnRate: 0.3,
} as const;

/**
 * All four numbers bad AT ONCE -> expansion halts. Adding token utility does not
 * fix a market that has not delivered physical vehicles yet.
 */
export function evaluateCorridorHealth(metrics: CorridorMetrics): { halted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.dealsCompleted < HALT_THRESHOLDS.minDealsCompleted) reasons.push('deals_completed_too_low');
  if (metrics.disputeRate > HALT_THRESHOLDS.maxDisputeRate) reasons.push('dispute_rate_too_high');
  if (metrics.unexplainedOdometerAnomalies > HALT_THRESHOLDS.maxUnexplainedAnomalies) {
    reasons.push('unexplained_odometer_anomalies');
  }
  if (
    metrics.sellerReturnRate < HALT_THRESHOLDS.minSellerReturnRate ||
    metrics.inspectorReturnRate < HALT_THRESHOLDS.minInspectorReturnRate
  ) {
    reasons.push('sellers_or_workshops_not_returning');
  }
  const halted = reasons.length >= 4;
  return { halted, reasons: halted ? reasons : [] };
}

// ---------------------------------------------------------------------------
// Publication stages (playbook §9)
// ---------------------------------------------------------------------------

export const PUBLICATION_STAGES = [
  {
    id: 'proof',
    label: 'Proof Stage',
    allowed: [
      'single_corridor',
      'mandatory_inspection',
      'mandatory_escrow',
      'vin_history_live',
      'receipt_nft_for_completed_deals',
      'stablecoin_bonds',
    ],
    forbidden: ['public_token_sale', 'token_price_projections'],
  },
  {
    id: 'market',
    label: 'Market Stage',
    allowed: [
      'third_party_workshops',
      'report_standard',
      'dispute_freeze',
      'public_metrics: deals_completed, median_hours_to_report, dispute_rate',
    ],
    forbidden: ['token_price_projections'],
  },
  {
    id: 'token',
    label: 'Token Stage',
    allowed: [
      'token_bonds',
      'token_fee_discount',
      'capacity_access',
      'distribution: operations, limited_liquidity, user_program',
    ],
    forbidden: ['revenue_rights_allocation', 'yield_promises_to_holders'],
  },
  {
    id: 'expansion',
    label: 'Expansion Stage',
    allowed: ['second_corridor', 'verified_local_workshops', 'older_vin_history_remains_readable'],
    forbidden: ['weakening_odometer_anomaly_rules_retroactively'],
  },
] as const;

export const PUBLIC_METRICS = ['deals_completed', 'median_hours_to_report', 'dispute_rate'] as const;

/** The only token metrics worth discussing. Trading volume is NOT proof of a living ecosystem. */
export const TOKEN_METRICS_NOTE =
  'The metrics that matter are the bond value locked by active sellers and workshops, the fees paid in the ' +
  'token, and the number of completed deals. Token trading volume beyond that does not prove a living ecosystem.';

export const DISCLAIMERS = {
  nftNotTitle:
    'The NFT on a VIN is a receipt and a claim trail, not a vehicle title. Registration papers, title, ' +
    'customs, tax, and ownership transfer follow the law of the origin and destination countries.',
  tokenNotEquity:
    'The VIN token is not company equity, is not a means to pay a vehicle price, pays no revenue share, ' +
    'and grants no voting rights over company revenue.',
  reportNotWarranty:
    'An inspection report states findings on the inspection date; it is not a warranty until the vehicle ' +
    'reaches the buyer country.',
  moneyRule:
    'Vehicle price, shipping, and inspection fees are paid in stablecoin or fiat. ' +
    'Sellers and workshops are paid in stablecoin or fiat and are never forced to hold the token.',
} as const;
