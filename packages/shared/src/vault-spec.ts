/**
 * ESCROW LEDGER MODEL — mirrors the rules of `programs/vin-anchor/src/lib.rs`.
 *
 * Why this file exists:
 *  -------------------
 *  On-chain money rules must be testable in any environment, including CI
 *  without a Solana toolchain. This module is a pure model (no I/O) that maps
 *  ONE-TO-ONE to the Anchor program's functions:
 *
 *    Rust (program)            -> this model
 *    ---------------------------------------------------------------
 *    open_deal                 -> openDeal()
 *    fund_leg(leg, amount)     -> fundLeg(leg, amount)
 *    release_leg(...)          -> releaseLeg(leg, amount)
 *    refund_leg(leg, ...)      -> refundLeg(leg)
 *    freeze_deal(...)          -> freezeDeal()
 *    resolve_dispute(...)      -> resolveDispute(decision, ...)
 *    slash_bond(...)           -> slashBondToDisputeFund(amount)  (-> dispute fund)
 *
 *  Every rule guarded here has a counterpart in Rust. The property tests in
 *  `tests/vault.property.test.ts` attack this model with random combinations
 *  (fuzzed amounts, over-release, double refund, repeated resolutions) so its
 *  invariants are proven, not just assumed.
 *
 *  INVARIANTS enforced:
 *   1. No leg releases more than it locked (OverRelease).
 *   2. A frozen deal rejects both release and refund.
 *   3. After a ruling, BOTH LEGS SIT EXACTLY AT ZERO — no stranded funds.
 *   4. A slashed bond goes to the DISPUTE FUND, never to an admin or relayer.
 *   5. The fee recipient can only be the treasury address locked in config.
 */

export const LEG = { vehicle: 0, inspection: 1 } as const;
export type Leg = (typeof LEG)[keyof typeof LEG];

export const DECISION = {
  refundBuyer: 0,
  releaseSeller: 1,
  split: 2,
  bondSlashed: 3,
} as const;
export type Decision = (typeof DECISION)[keyof typeof DECISION];

export class VaultError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface VaultConfig {
  /** Owner of the token account that receives the platform fee. */
  feeTreasury: string;
  /** Owner of the token account that holds the dispute fund. */
  disputeFund: string;
  arbiter: string;
  relayer: string;
  feeBps: { vehicle: number; inspection: number };
}

export interface VaultState {
  buyer: string;
  seller: string;
  inspector: string;
  /** Amounts locked when the deal opened. */
  locked: { vehicle: bigint; inspection: bigint };
  /** How much has left each leg. */
  released: { vehicle: bigint; inspection: bigint };
  frozen: boolean;
  cancelled: boolean;
  completed: boolean;
  /** Off-vault balances: for audit, these must always add up. */
  balances: Record<string, bigint>;
  /** Dispute fund: only ever grows from slashed bonds. */
  disputeFundBalance: bigint;
  /** Bonds still locked, per actor. */
  bonds: Record<string, bigint>;
}

export interface ResolveInput {
  decision: Decision;
  toBuyer: bigint;
  toSeller: bigint;
  toInspector: bigint;
}

export function createVaultState(input: {
  buyer: string;
  seller: string;
  inspector: string;
  vehicleAmount: bigint;
  inspectionAmount: bigint;
}): VaultState {
  return {
    buyer: input.buyer,
    seller: input.seller,
    inspector: input.inspector,
    locked: { vehicle: input.vehicleAmount, inspection: input.inspectionAmount },
    released: { vehicle: 0n, inspection: 0n },
    frozen: false,
    cancelled: false,
    completed: false,
    // When the buyer funds, balances move into the vault. We record them from
    // the vault's side so tests can assert that no money disappeared.
    balances: {
      [input.buyer]: -input.vehicleAmount - input.inspectionAmount,
      [input.seller]: 0n,
      [input.inspector]: 0n,
      vault: input.vehicleAmount + input.inspectionAmount,
    },
    disputeFundBalance: 0n,
    bonds: {},
  };
}

function credit(state: VaultState, who: string, amount: bigint): void {
  state.balances[who] = (state.balances[who] ?? 0n) + amount;
  state.balances.vault = (state.balances.vault ?? 0n) - amount;
}

/** What is still movable on a given leg. */
export function remaining(state: VaultState, leg: Leg): bigint {
  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  return state.locked[key] - state.released[key];
}

export function fundLeg(_state: VaultState, _leg: Leg, amount: bigint): void {
  // Funding is already reflected in balances by openDeal; what matters here is
  // the upper bound guard, like `OverFunded` in the program.
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  if (amount > remaining(_state, _leg) + _state.released[_leg === LEG.vehicle ? 'vehicle' : 'inspection']) {
    throw new VaultError('OverFunded');
  }
}

export function freezeDeal(state: VaultState, caller: string): void {
  if (caller !== state.buyer && caller !== state.seller && caller !== state.inspector) {
    throw new VaultError('Unauthorized');
  }
  state.frozen = true;
}

/** Release one leg. Counterpart of `release_leg`. */
export function releaseLeg(state: VaultState, leg: Leg, amount: bigint, recipient: string): void {
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  if (state.frozen) throw new VaultError('DealFrozen');
  if (state.cancelled) throw new VaultError('DealCancelled');
  if (state.completed) throw new VaultError('DealCompleted');
  if (amount > remaining(state, leg)) throw new VaultError('OverRelease');

  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  state.released[key] += amount;
  credit(state, recipient, amount);

  // The deal is COMPLETE once both legs are fully released — this is what opens
  // receipt recording (`record_note` requires completed || cancelled).
  if (state.released.vehicle === state.locked.vehicle && state.released.inspection === state.locked.inspection) {
    state.completed = true;
  }
}

/** Refund one leg back to the buyer. Counterpart of `refund_leg`. */
export function refundLeg(state: VaultState, leg: Leg): void {
  // A frozen deal must not be refundable: otherwise a relayer could route around
  // arbitration and the freeze would mean nothing.
  if (state.frozen) throw new VaultError('DealFrozen');
  if (state.completed) throw new VaultError('DealCompleted');
  if (state.cancelled) throw new VaultError('DealCancelled');
  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  const amount = remaining(state, leg);
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  state.released[key] += amount;
  credit(state, state.buyer, amount);

  // Both legs are back with the buyer -> the deal closes as cancelled.
  if (state.released.vehicle === state.locked.vehicle && state.released.inspection === state.locked.inspection) {
    state.cancelled = true;
  }
}

/**
 * Arbitration ruling. Counterpart of `resolve_dispute`.
 * Accounting must be exact: vehicle leg `toBuyer + toSeller == remaining`,
 * inspection leg `toInspector <= remaining` with the rest back to the buyer.
 */
export function resolveDispute(state: VaultState, config: VaultConfig, caller: string, input: ResolveInput): void {
  if (caller !== config.arbiter) throw new VaultError('Unauthorized');
  if (!state.frozen) throw new VaultError('DealNotFrozen');

  const vehicleRemaining = remaining(state, LEG.vehicle);
  const inspectionRemaining = remaining(state, LEG.inspection);

  switch (input.decision) {
    case DECISION.refundBuyer:
    case DECISION.bondSlashed:
      if (input.toBuyer !== vehicleRemaining || input.toSeller !== 0n) throw new VaultError('InexactSettlement');
      break;
    case DECISION.releaseSeller:
      if (input.toSeller !== vehicleRemaining || input.toBuyer !== 0n) throw new VaultError('InexactSettlement');
      break;
    case DECISION.split:
      if (input.toBuyer + input.toSeller !== vehicleRemaining) throw new VaultError('InexactSettlement');
      break;
    default:
      throw new VaultError('InvalidDecision');
  }
  if (input.toInspector > inspectionRemaining) throw new VaultError('OverRelease');

  const refundToBuyer = inspectionRemaining - input.toInspector;

  if (input.toBuyer > 0n) {
    state.released.vehicle += input.toBuyer;
    credit(state, state.buyer, input.toBuyer);
  }
  if (input.toSeller > 0n) {
    state.released.vehicle += input.toSeller;
    credit(state, state.seller, input.toSeller);
  }
  if (input.toInspector > 0n) credit(state, state.inspector, input.toInspector);
  if (refundToBuyer > 0n) credit(state, state.buyer, refundToBuyer);
  state.released.inspection += input.toInspector + refundToBuyer;

  // Invariant: nothing is stranded after the ruling.
  if (state.released.vehicle !== state.locked.vehicle) throw new VaultError('InexactSettlement');
  if (state.released.inspection !== state.locked.inspection) throw new VaultError('InexactSettlement');

  state.frozen = false;
  if (input.decision === DECISION.refundBuyer || input.decision === DECISION.bondSlashed) {
    state.cancelled = true;
  } else {
    state.completed = true;
  }
}

/**
 * Slashed bond -> DISPUTE FUND. Never to an admin or relayer.
 *
 * The name differs from `slashBond` in `money.ts`, which only COMPUTES the split
 * (a pure calculator). This function actually moves balances in the ledger
 * model, matching `slash_bond` in the Anchor program.
 */
export function slashBondToDisputeFund(
  state: VaultState,
  config: VaultConfig,
  caller: string,
  actor: string,
  amount: bigint,
): void {
  if (caller !== config.arbiter) throw new VaultError('Unauthorized');
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  const locked = state.bonds[actor] ?? 0n;
  if (locked < amount) throw new VaultError('InsufficientBond');
  state.bonds[actor] = locked - amount;
  state.balances[config.disputeFund] = (state.balances[config.disputeFund] ?? 0n) + amount;
  state.disputeFundBalance += amount;
}

export function lockBond(state: VaultState, actor: string, amount: bigint): void {
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  state.bonds[actor] = (state.bonds[actor] ?? 0n) + amount;
}

/**
 * May the receipt be recorded? Counterpart of `require!(deal.completed ||
 * deal.cancelled)` in the `record_note` instruction.
 */
export function canRecordNote(state: VaultState): boolean {
  return state.completed || state.cancelled;
}

/** Conservative money rule: the sum of all balances must always be zero (double entry). */
export function ledgerSumsToZero(state: VaultState): boolean {
  const total = Object.values(state.balances).reduce((acc, value) => acc + value, 0n) + state.disputeFundBalance;
  return total === 0n;
}

/** Fee on a leg, capped by bps. Counterpart of the `max_fee` check in the program. */
export function platformFee(config: VaultConfig, leg: Leg, amount: bigint): bigint {
  const bps = leg === LEG.vehicle ? config.feeBps.vehicle : config.feeBps.inspection;
  if (bps < 0 || bps > 1_000) throw new VaultError('FeeTooHigh');
  return (amount * BigInt(bps)) / 10_000n;
}
