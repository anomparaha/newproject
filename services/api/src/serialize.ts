import type {
  Actor,
  Bond,
  Deal,
  DealState,
  Dispute,
  DisputeOutcome,
  InspectionReport,
  Listing,
  ListingStatus,
  Role,
  VerificationLevel,
} from '@vin/shared';
import { json, type Row } from './db.js';

export function serializeActor(row: Row): Actor {
  return {
    id: String(row.id),
    role: String(row.role) as Role,
    displayName: String(row.display_name),
    email: String(row.email),
    walletAddress: row.wallet_address === null ? null : String(row.wallet_address),
    payoutAddress: row.payout_address === null ? null : String(row.payout_address),
    verification: String(row.verification) as VerificationLevel,
    countryCode: String(row.country_code),
    city: row.city === null ? null : String(row.city),
    baseCurrency: String(row.base_currency),
    createdAt: String(row.created_at),
  };
}

export function serializeListing(row: Row): Listing {
  return {
    id: String(row.id),
    vin: String(row.vin),
    sellerId: String(row.seller_id),
    make: String(row.make),
    model: String(row.model),
    year: Number(row.year),
    odometerKm: row.odometer_km === null ? null : Number(row.odometer_km),
    location: String(row.location),
    priceAmount: String(row.price_amount),
    priceCurrency: String(row.price_currency) as Listing['priceCurrency'],
    shippingTerms: String(row.shipping_terms),
    photoHashes: json<string[]>(row.photo_hashes as string, []),
    status: String(row.status) as ListingStatus,
    bondAmount: String(row.bond_amount),
    bondCurrency: String(row.bond_currency) as Listing['bondCurrency'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function serializeDeal(row: Row): Deal {
  return {
    id: String(row.id),
    listingId: String(row.listing_id),
    vin: String(row.vin),
    buyerId: String(row.buyer_id),
    sellerId: String(row.seller_id),
    inspectorId: String(row.inspector_id),
    state: String(row.state) as DealState,
    priceAmount: String(row.price_amount),
    priceCurrency: String(row.price_currency),
    shippingPaidBy: String(row.shipping_paid_by) as 'buyer' | 'seller',
    shippingAmount: String(row.shipping_amount),
    inspectionFeeAmount: String(row.inspection_fee_amount),
    escrowRefVehicle: row.escrow_ref_vehicle === null ? null : String(row.escrow_ref_vehicle),
    escrowRefInspection: row.escrow_ref_inspection === null ? null : String(row.escrow_ref_inspection),
    inspectionReleasedAt: row.inspection_released_at === null ? null : String(row.inspection_released_at),
    vehicleReleasedAt: row.vehicle_released_at === null ? null : String(row.vehicle_released_at),
    inspectionDeadline: String(row.inspection_deadline),
    handoverTerms: String(row.handover_terms),
    handoverConfirmedBy: json<string[]>(row.handover_confirmed_by as string, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function serializeReport(row: Row): InspectionReport & { checklist: Record<string, boolean> } {
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    vin: String(row.vin),
    inspectorId: String(row.inspector_id),
    odometerKm: Number(row.odometer_km),
    inspectedAt: String(row.inspected_at),
    reportHash: String(row.report_hash),
    dashboardPhotoHash: String(row.dashboard_photo_hash),
    conditionSummary: String(row.condition_summary),
    standardVersion: String(row.standard_version),
    anomaly: Number(row.anomaly) === 1,
    checklist: json<Record<string, boolean>>(row.checklist as string, {}),
  };
}

export function serializeDispute(row: Row): Dispute {
  return {
    id: String(row.id),
    dealId: String(row.deal_id),
    openedBy: String(row.opened_by),
    reason: String(row.reason),
    state: String(row.state) as Dispute['state'],
    outcome: row.outcome === null ? null : (String(row.outcome) as DisputeOutcome),
    arbiterId: row.arbiter_id === null ? null : String(row.arbiter_id),
    bondSlashedAmount: row.bond_slashed_amount === null ? null : String(row.bond_slashed_amount),
    refundedAmount: row.refunded_amount === null ? null : String(row.refunded_amount),
    releasedAmount: row.released_amount === null ? null : String(row.released_amount),
    arbiterNote: row.arbiter_note === null ? null : String(row.arbiter_note),
    openedAt: String(row.opened_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

export function serializeBond(row: Row): Bond {
  return {
    id: String(row.id),
    actorId: String(row.actor_id),
    purpose: String(row.purpose) as Bond['purpose'],
    amount: String(row.amount),
    currency: String(row.currency) as Bond['currency'],
    state: String(row.state) as Bond['state'],
    listingId: row.listing_id === null ? null : String(row.listing_id),
    lockedAt: String(row.locked_at),
    settledAt: row.settled_at === null ? null : String(row.settled_at),
    reason: row.reason === null ? null : String(row.reason),
  };
}

export function serializeNote(row: Row) {
  return {
    id: String(row.id),
    vin: String(row.vin),
    dealId: String(row.deal_id),
    buyerId: String(row.buyer_id),
    sellerId: String(row.seller_id),
    ownerId: String(row.owner_id),
    priceAmount: String(row.price_amount),
    priceCurrency: String(row.price_currency),
    evidenceRoot: String(row.evidence_root),
    escrowTxId: row.escrow_tx_id === null ? null : String(row.escrow_tx_id),
    status: String(row.status),
    assetId: row.asset_id === null ? null : String(row.asset_id),
    metadataUri: row.metadata_uri === null ? null : String(row.metadata_uri),
    createdAt: String(row.created_at),
  };
}
