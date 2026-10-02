export * from './types.js';
export * from './state.js';
export * from './money.js';
export * from './schema.js';
export * from './escrow.js';
// vault-spec exports slashBondToDisputeFund (a ledger action), which is different
// from slashBond in money.ts — that one only COMPUTES the slash split.
export * from './vault-spec.js';
// On-chain rules reconciled with the five-contract design spec (valid call order
// plus a VIN registry that computes odometer anomalies on-chain).
export * from './onchain-rules.js';
