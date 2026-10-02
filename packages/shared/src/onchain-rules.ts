/**
 * ON-CHAIN RULES (reconciled version)
 * ===================================
 *
 * This model encodes two fixes taken from the five-contract design spec (see
 * `docs/SPEC_RECONCILIATION.md`), so the rules can be executed and tested BEFORE
 * they are written in Rust:
 *
 *   1. VALID CALL ORDER — an explicit state machine. Calls outside the order are
 *      rejected (the equivalent of "must revert" on EVM).
 *
 *   2. VIN REGISTRY WITH ON-CHAIN ANOMALY MATH — the registry keeps
 *      `maxOdometer` per vinHash, so odometer anomalies are computed from
 *      on-chain state rather than from the server. The server may only DISPLAY;
 *      it cannot hide a gap because the threshold is computed here.
 *
 * A note on odometers: if we stored only the "latest reading", one low report
 * would reset the comparison baseline and the next anomaly would vanish. That is
 * why the registry keeps TWO numbers:
 *   - `lastOdometer` : the most recent reading (for the history view)
 *   - `maxOdometer`  : the highest reading ever recorded (the anomaly baseline)
 * An anomaly means `odometer < maxOdometer`.
 *
 * This file is pure (no I/O) and is shared by the API, the tests, and the future
 * Rust instructions. Rust counterparts to add to the program:
 * `init_vin_record`, `record_listing`, `record_reserve`, `record_inspection`,
 * `acknowledge_anomaly`, `record_completion`, `record_dispute`,
 * `record_resolution`, and a `DealState` enum on `DealAccount`.
 */

export class RuleViolation extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    // The message always starts with the rule code so on-chain and off-chain
    // logs can be matched against the rule table in the documentation.
    super(message ? `${code}: ${message}` : code);
  }
}

// ---------------------------------------------------------------------------
// 1. VALID CALL ORDER
// ---------------------------------------------------------------------------

/**
 * Deal stage. The numbers are used as-is so the order is readable and
 * comparable (`>` / `<`), like an enum on-chain.
 */
export const STAGE = {
  empty: 0,
  /** Seller/workshop bond locked in the StakeVault. */
  staked: 1,
  /** recordListing: the listing is registered in the registry. */
  listed: 2,
  /** createDeal: the listing becomes reserved, a dealId is created. */
  reserved: 3,
  /** deposit: the stablecoin unit price enters the vehicle escrow. */
  funded: 4,
  /** fundInspection: the workshop fee enters the inspection escrow. */
  inspecting: 5,
  /** submitReport: the workshop report (hash + odometer). */
  reportSubmitted: 6,
  /** acceptReport: the buyer accepts; inspection funds release to the workshop. */
  reportAccepted: 7,
  /** markHandover: the seller attaches a proofHash. */
  handoverMarked: 8,
  /** confirmHandover: the buyer confirms (or the window passes with no dispute). */
  handoverConfirmed: 9,
  /** release: vehicle funds release to the seller after the fee. */
  released: 10,
  /** mintNote: the receipt is issued. */
  noted: 11,
  /** openDispute halts the normal path. */
  frozen: 90,
  /** resolve: arbitration ruling. */
  resolved: 91,
} as const;

export type Stage = (typeof STAGE)[keyof typeof STAGE];

/** The dispute branch may open from any stage once funds are in. */
const DISPUTABLE_FROM: Stage[] = [STAGE.funded, STAGE.inspecting, STAGE.reportSubmitted, STAGE.reportAccepted, STAGE.handoverMarked];

export const ACTION = {
  lockStake: 'lock_stake',
  recordListing: 'record_listing',
  createDeal: 'create_deal',
  deposit: 'deposit',
  fundInspection: 'fund_inspection',
  submitReport: 'submit_report',
  acceptReport: 'accept_report',
  markHandover: 'mark_handover',
  confirmHandover: 'confirm_handover',
  release: 'release',
  mintNote: 'mint_note',
  openDispute: 'open_dispute',
  resolveDispute: 'resolve_dispute',
} as const;
export type Action = (typeof ACTION)[keyof typeof ACTION];

interface TransitionRule {
  from: Stage[];
  to: Stage;
  /** Who may trigger it (the counterpart of signer checks in Rust). */
  actor: 'seller' | 'buyer' | 'inspector' | 'operator' | 'arbiter' | 'anyone';
}

/**
 * Valid-order table. Any instruction outside this table is rejected.
 *
 * Note `release`: per the design spec it needs NO relayer — anyone may call it
 * once the conditions are proven. That removes the "platform hot key" trust
 * point present in the older design.
 */
export const DEAL_ORDER: Record<Action, TransitionRule> = {
  lock_stake: { from: [STAGE.empty], to: STAGE.staked, actor: 'seller' },
  record_listing: { from: [STAGE.staked], to: STAGE.listed, actor: 'seller' },
  create_deal: { from: [STAGE.listed], to: STAGE.reserved, actor: 'buyer' },
  deposit: { from: [STAGE.reserved], to: STAGE.funded, actor: 'buyer' },
  fund_inspection: { from: [STAGE.funded], to: STAGE.inspecting, actor: 'buyer' },
  submit_report: { from: [STAGE.inspecting], to: STAGE.reportSubmitted, actor: 'inspector' },
  accept_report: { from: [STAGE.reportSubmitted], to: STAGE.reportAccepted, actor: 'buyer' },
  mark_handover: { from: [STAGE.reportAccepted], to: STAGE.handoverMarked, actor: 'seller' },
  confirm_handover: { from: [STAGE.handoverMarked], to: STAGE.handoverConfirmed, actor: 'buyer' },
  release: { from: [STAGE.handoverConfirmed], to: STAGE.released, actor: 'anyone' },
  mint_note: { from: [STAGE.released], to: STAGE.noted, actor: 'anyone' },
  open_dispute: { from: DISPUTABLE_FROM, to: STAGE.frozen, actor: 'anyone' },
  resolve_dispute: { from: [STAGE.frozen], to: STAGE.resolved, actor: 'arbiter' },
};

export interface DealMachineState {
  stage: Stage;
  /** Buyer confirmation window (hours) after markHandover. */
  confirmWindowHours: number;
  handoverMarkedAt: string | null;
  /** An open dispute case holds every funds movement. */
  disputeOpen: boolean;
  /** Has the receipt been minted? A receipt is never overwritten. */
  noteMinted: boolean;
}

export function initDealState(confirmWindowHours = 72): DealMachineState {
  return {
    stage: STAGE.empty,
    confirmWindowHours,
    handoverMarkedAt: null,
    disputeOpen: false,
    noteMinted: false,
  };
}

export interface CallContext {
  actor: 'seller' | 'buyer' | 'inspector' | 'operator' | 'arbiter' | 'anyone';
  now: string;
}

/**
 * Checks whether an action is valid at the current stage. Throws when the call
 * is out of order — the counterpart of `revert` on EVM.
 */
export function assertCallOrder(state: DealMachineState, action: Action, ctx: CallContext): TransitionRule {
  const rule = DEAL_ORDER[action];
  if (!rule) throw new RuleViolation('UNKNOWN_ACTION', `Unknown action: ${action}`);

  if (state.disputeOpen && action !== ACTION.resolveDispute && action !== ACTION.openDispute) {
    throw new RuleViolation('DISPUTE_OPEN', `Deal is frozen by a dispute; "${action}" cannot run.`);
  }
  if (!rule.from.includes(state.stage)) {
    throw new RuleViolation(
      'OUT_OF_ORDER',
      `"${action}" is not valid at stage ${state.stage}; it must run from ${rule.from.join(' or ')}.`,
    );
  }
  if (rule.actor !== 'anyone' && rule.actor !== ctx.actor) {
    throw new RuleViolation('WRONG_ACTOR', `"${action}" may only be triggered by ${rule.actor}, not ${ctx.actor}.`);
  }
  if (action === ACTION.mintNote && state.noteMinted) {
    throw new RuleViolation('NOTE_EXISTS', 'A receipt has already been minted for this deal.');
  }
  return rule;
}

/** Apply an action that already passed the checks. */
export function applyCall(state: DealMachineState, action: Action, ctx: CallContext): DealMachineState {
  const rule = assertCallOrder(state, action, ctx);
  const next: DealMachineState = { ...state, stage: rule.to };
  if (action === ACTION.markHandover) next.handoverMarkedAt = ctx.now;
  if (action === ACTION.openDispute) next.disputeOpen = true;
  if (action === ACTION.resolveDispute) next.disputeOpen = false;
  if (action === ACTION.mintNote) next.noteMinted = true;
  return next;
}

/** Buyer confirmation deadline (ISO) or null when handover has not been marked. */
export function confirmDeadline(state: DealMachineState): string | null {
  if (!state.handoverMarkedAt) return null;
  return new Date(Date.parse(state.handoverMarkedAt) + state.confirmWindowHours * 3_600_000).toISOString();
}

/**
 * The confirmation window passed with no dispute: a silent buyer must not hold
 * the funds forever. Under this rule `release` becomes valid even if
 * `confirm_handover` was never called — but only once the window has passed AND
 * no dispute is open.
 */
export function windowElapsedWithoutDispute(state: DealMachineState, now: string): boolean {
  const deadline = confirmDeadline(state);
  if (!deadline) return false;
  return !state.disputeOpen && Date.parse(now) >= Date.parse(deadline);
}

export function canRelease(state: DealMachineState, now: string): { ok: boolean; reason: string } {
  if (state.disputeOpen) return { ok: false, reason: 'dispute_open' };
  if (state.stage === STAGE.handoverConfirmed) return { ok: true, reason: 'confirmed_by_buyer' };
  if (state.stage === STAGE.handoverMarked && windowElapsedWithoutDispute(state, now)) {
    return { ok: true, reason: 'confirm_window_elapsed_without_dispute' };
  }
  if (state.stage === STAGE.frozen) return { ok: false, reason: 'awaiting_arbiter_ruling' };
  return { ok: false, reason: `stage_${state.stage}_not_ready` };
}

// ---------------------------------------------------------------------------
// 2. VIN REGISTRY WITH ON-CHAIN ANOMALY MATH
// ---------------------------------------------------------------------------

export interface VinRegistryRecord {
  /** Registry key: the normalised VIN hash, never the raw VIN. */
  vinHash: string;
  seller: string;
  /** Most recent reading (history view). */
  lastOdometer: number | null;
  /** Highest reading ever recorded — the BASELINE for anomaly math. */
  maxOdometer: number | null;
  /** Number of events ever written; it can only grow. */
  events: number;
  /** An anomaly the buyer must see before a report may be accepted. */
  anomalyPending: boolean;
  /** Permanent anomaly log: it is never deleted. */
  anomalies: Array<{ odometer: number; previousMax: number; at: string; dealId: string }>;
  listingRecorded: boolean;
  reservedByDeal: string | null;
  completionRecorded: boolean;
  disputeOpen: boolean;
}

export function initVinRecord(vinHash: string, seller: string): VinRegistryRecord {
  return {
    vinHash,
    seller,
    lastOdometer: null,
    maxOdometer: null,
    events: 0,
    anomalyPending: false,
    anomalies: [],
    listingRecorded: false,
    reservedByDeal: null,
    completionRecorded: false,
    disputeOpen: false,
  };
}

function appendEvent(record: VinRegistryRecord): VinRegistryRecord {
  // Append-only: the event count only grows, nothing is ever deleted.
  return { ...record, events: record.events + 1 };
}

export function recordListing(record: VinRegistryRecord, seller: string): VinRegistryRecord {
  if (record.listingRecorded) throw new RuleViolation('LISTING_EXISTS', 'A listing for this vinHash is already recorded.');
  if (seller !== record.seller) throw new RuleViolation('WRONG_SELLER', 'The seller does not match the record owner.');
  return appendEvent({ ...record, listingRecorded: true });
}

/**
 * `recordReserve`: one VIN may have only ONE active deal.
 * This is the on-chain guard the old program lacked (the old `open_deal` used
 * seeds [deal, vin_hash, buyer], so two buyers could open two parallel deals for
 * the same VIN).
 */
export function recordReserve(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (!record.listingRecorded) throw new RuleViolation('NOT_LISTED', 'The listing is not recorded yet.');
  if (record.reservedByDeal) {
    throw new RuleViolation('ALREADY_RESERVED', `This VIN is already locked by deal ${record.reservedByDeal}.`);
  }
  return appendEvent({ ...record, reservedByDeal: dealId });
}

export function releaseReserve(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'This deal does not hold the reserve.');
  return appendEvent({ ...record, reservedByDeal: null });
}

export interface InspectionInput {
  dealId: string;
  odometerKm: number;
  reportHash: string;
  at: string;
}

/**
 * `recordInspection`: writes the report AND computes the anomaly from on-chain
 * state. The server cannot hide a gap because the threshold lives here.
 */
export function recordInspection(record: VinRegistryRecord, input: InspectionInput): { record: VinRegistryRecord; anomaly: boolean } {
  if (record.reservedByDeal !== input.dealId) {
    throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'A report is valid only for the deal that holds this VIN reserve.');
  }
  if (input.odometerKm < 0) throw new RuleViolation('INVALID_ODOMETER', 'Odometer readings cannot be negative.');

  const baseline = record.maxOdometer;
  const anomaly = baseline !== null && input.odometerKm < baseline;

  let next: VinRegistryRecord = {
    ...record,
    lastOdometer: input.odometerKm,
    // The high-water mark never drops: a low report cannot reset the baseline.
    maxOdometer: baseline === null ? input.odometerKm : Math.max(baseline, input.odometerKm),
    anomalyPending: record.anomalyPending || anomaly,
  };
  if (anomaly) {
    next = {
      ...next,
      anomalies: [
        ...next.anomalies,
        { odometer: input.odometerKm, previousMax: baseline as number, at: input.at, dealId: input.dealId },
      ],
    };
  }
  return { record: appendEvent(next), anomaly };
}

/**
 * The buyer sees the warning. This is REQUIRED before `accept_report`, but it
 * does not erase the anomaly log — it only marks that the buyer has seen it.
 */
export function acknowledgeAnomaly(record: VinRegistryRecord, by: 'buyer'): VinRegistryRecord {
  if (!record.anomalyPending) throw new RuleViolation('NO_ANOMALY', 'There is no pending anomaly.');
  if (by !== 'buyer') throw new RuleViolation('WRONG_ACTOR', 'Only the buyer may acknowledge the warning.');
  return appendEvent({ ...record, anomalyPending: false });
}

/** `acceptReport` is rejected while an anomaly the buyer has not seen is pending. */
export function assertCanAcceptReport(record: VinRegistryRecord): void {
  if (record.anomalyPending) {
    throw new RuleViolation('ANOMALY_PENDING', 'The buyer has not seen the odometer anomaly; the report cannot be accepted.');
  }
}

export function recordCompletion(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'The deal does not hold the reserve.');
  if (record.disputeOpen) throw new RuleViolation('DISPUTE_OPEN', 'A dispute is still open; completion waits for the arbiter ruling.');
  if (record.completionRecorded) throw new RuleViolation('COMPLETION_EXISTS', 'Completion is already recorded.');
  return appendEvent({ ...record, completionRecorded: true });
}

export function recordDispute(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'The deal does not hold the reserve.');
  return appendEvent({ ...record, disputeOpen: true });
}

export function recordResolution(record: VinRegistryRecord): VinRegistryRecord {
  if (!record.disputeOpen) throw new RuleViolation('NO_DISPUTE', 'There is no open dispute.');
  return appendEvent({ ...record, disputeOpen: false });
}

/**
 * The four corridor health numbers are computed from the registry rather than
 * from an internal database: completed deals, disputes, unexplained anomalies,
 * and whether actors come back. (Full corridor metrics are derived in the API
 * from this data.)
 */
export function registryHealth(records: VinRegistryRecord[]): {
  total: number;
  completed: number;
  disputed: number;
  unresolvedAnomalies: number;
} {
  return {
    total: records.length,
    completed: records.filter((r) => r.completionRecorded).length,
    disputed: records.filter((r) => r.disputeOpen).length,
    unresolvedAnomalies: records.filter((r) => r.anomalyPending).length,
  };
}
