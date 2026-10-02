/**
 * PROPERTY tests for the escrow ledger model (a mirror of the Anchor program rules).
 *
 * How it works: fast-check generates thousands of random combinations (amounts,
 * action order, attempted fraud) and after every sequence we check the
 * invariants. So we test more than "the one scenario I thought of" — we cover a
 * large space of possibilities. This is the closest thing to on-chain fuzzing
 * that can run without a Solana toolchain.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  DECISION,
  LEG,
  VaultError,
  canRecordNote,
  createVaultState,
  freezeDeal,
  ledgerSumsToZero,
  lockBond,
  platformFee,
  refundLeg,
  releaseLeg,
  remaining,
  resolveDispute,
  slashBondToDisputeFund,
  type VaultConfig,
  type VaultState,
} from '../dist/index.js';

const CONFIG: VaultConfig = {
  feeTreasury: 'treasury',
  disputeFund: 'dispute_fund',
  arbiter: 'arbiter',
  relayer: 'relayer',
  feeBps: { vehicle: 100, inspection: 500 },
};

const ACTORS = { buyer: 'buyer', seller: 'seller', inspector: 'inspector' };

function fresh(vehicleAmount: bigint, inspectionAmount: bigint): VaultState {
  return createVaultState({ ...ACTORS, vehicleAmount, inspectionAmount });
}

const amountArb = fc.bigInt({ min: 1n, max: 100_000_000_000n });

test('invariant 1: a release never exceeds the amount locked', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.array(fc.bigInt({ min: 1n, max: 10_000_000n }), { maxLength: 12 }), (vehicle, inspection, attempts) => {
      const state = fresh(vehicle, inspection);
      let releasedTotal = 0n;
      for (const amount of attempts) {
        try {
          releaseLeg(state, LEG.vehicle, amount, ACTORS.seller);
          releasedTotal += amount;
        } catch (error) {
          assert.ok(error instanceof VaultError);
        }
        assert.ok(
          state.released.vehicle <= state.locked.vehicle,
          'the vehicle leg released more than it locked',
        );
      }
      assert.equal(state.released.vehicle, releasedTotal);
    }),
    { numRuns: 500 },
  );
});

test('invariant 2: a frozen deal rejects both release and refund', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.bigInt({ min: 1n, max: 1_000_000n }), (vehicle, inspection, amount) => {
      const state = fresh(vehicle, inspection);
      freezeDeal(state, ACTORS.buyer);

      assert.throws(() => releaseLeg(state, LEG.vehicle, amount, ACTORS.seller), /DealFrozen/);
      assert.throws(() => refundLeg(state, LEG.inspection), /DealFrozen|DealCancelled/);
      // The funds stay untouched in the vault while frozen.
      assert.equal(state.released.vehicle, 0n);
      assert.equal(state.released.inspection, 0n);
    }),
    { numRuns: 300 },
  );
});

test('invariant 3: after a ruling both legs sit exactly at zero (no stranded funds)', () => {
  fc.assert(
    fc.property(
      amountArb,
      amountArb,
      fc.bigInt({ min: 0n, max: 100_000_000_000n }),
      fc.constantFrom(DECISION.refundBuyer, DECISION.bondSlashed, DECISION.releaseSeller),
      (vehicle, inspection, toInspectorRaw, decision) => {
        const state = fresh(vehicle, inspection);
        const toInspector = toInspectorRaw % (inspection + 1n);
        freezeDeal(state, ACTORS.seller);

        resolveDispute(state, CONFIG, CONFIG.arbiter, {
          decision,
          toBuyer: decision === DECISION.releaseSeller ? 0n : vehicle,
          toSeller: decision === DECISION.releaseSeller ? vehicle : 0n,
          toInspector,
        });

        assert.equal(state.released.vehicle, state.locked.vehicle);
        assert.equal(state.released.inspection, state.locked.inspection);
        assert.equal(state.balances.vault, 0n, 'the vault must be empty after the ruling');
        assert.equal(state.balances[ACTORS.inspector], toInspector);
        assert.ok(ledgerSumsToZero(state), 'double-entry accounting must always sum to zero');
      },
    ),
    { numRuns: 500 },
  );
});

test('invariant 3b: a split that does not add up exactly is REJECTED (no stranded funds)', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.bigInt({ min: 1n, max: 1_000_000n }), (vehicle, inspection, shortfall) => {
      const state = fresh(vehicle, inspection);
      freezeDeal(state, ACTORS.buyer);
      const invalid = vehicle > shortfall ? vehicle - shortfall : vehicle + shortfall;
      assert.throws(
        () =>
          resolveDispute(state, CONFIG, CONFIG.arbiter, {
            decision: DECISION.split,
            toBuyer: invalid,
            toSeller: 0n,
            toInspector: 0n,
          }),
        /InexactSettlement|OverRelease/,
      );
    }),
    { numRuns: 300 },
  );
});

test('invariant 4: a slashed bond always goes to the dispute fund, never to an admin or relayer', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.bigInt({ min: 1n, max: 1_000_000n }), (vehicle, inspection, bondAmount) => {
      const state = fresh(vehicle, inspection);
      lockBond(state, ACTORS.seller, bondAmount);
      // 1..bondAmount (never above the locked bond)
      const slashAmount = ((bondAmount - 1n) % 1_000_000n) + 1n;

      slashBondToDisputeFund(state, CONFIG, CONFIG.arbiter, ACTORS.seller, slashAmount);

      assert.equal(state.disputeFundBalance, slashAmount);
      assert.equal(state.balances[CONFIG.disputeFund], slashAmount);
      assert.equal(state.balances['admin'] ?? 0n, 0n, 'an admin must never receive a slashed bond');
      assert.equal(state.balances[CONFIG.relayer] ?? 0n, 0n, 'a relayer must never receive a slashed bond');
      assert.equal(state.bonds[ACTORS.seller], bondAmount - slashAmount);
    }),
    { numRuns: 300 },
  );
});

test('invariant 5: only the arbiter rules; only deal parties may freeze', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      assert.throws(() => freezeDeal(state, 'outsider'), /Unauthorized/);
      freezeDeal(state, ACTORS.inspector);
      assert.throws(
        () =>
          resolveDispute(state, CONFIG, 'not_arbiter', {
            decision: DECISION.refundBuyer,
            toBuyer: vehicle,
            toSeller: 0n,
            toInspector: 0n,
          }),
        /Unauthorized/,
      );
    }),
    { numRuns: 200 },
  );
});

test('invariant 6: a double refund is rejected (funds cannot go back twice)', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      refundLeg(state, LEG.vehicle);
      assert.equal(state.released.vehicle, state.locked.vehicle);
      assert.throws(() => refundLeg(state, LEG.vehicle), /DealCancelled|ZeroAmount|DealCompleted/);
      // The inspection leg must be unaffected.
      assert.equal(state.released.inspection, 0n);
    }),
    { numRuns: 300 },
  );
});

test('invariant 7: the fee is capped by bps and accounting stays balanced', () => {
  fc.assert(
    fc.property(amountArb, fc.constantFrom(LEG.vehicle, LEG.inspection), (amount, leg) => {
      const fee = platformFee(CONFIG, leg, amount);
      const bps = leg === LEG.vehicle ? CONFIG.feeBps.vehicle : CONFIG.feeBps.inspection;
      assert.ok(fee <= (amount * BigInt(bps)) / 10_000n);
      assert.ok(fee >= 0n);
      assert.throws(
        () => platformFee({ ...CONFIG, feeBps: { vehicle: 1_001, inspection: 0 } }, LEG.vehicle, amount),
        /FeeTooHigh/,
      );
    }),
    { numRuns: 300 },
  );
});

test('invariant 8: a receipt may only be recorded after BOTH legs settle', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      assert.equal(canRecordNote(state), false, 'no receipt before the deal closes');

      releaseLeg(state, LEG.inspection, inspection, ACTORS.inspector);
      assert.equal(canRecordNote(state), false, 'one settled leg does not close the deal');

      releaseLeg(state, LEG.vehicle, vehicle, ACTORS.seller);
      assert.equal(state.completed, true, 'the deal must complete once both legs settle');
      assert.equal(canRecordNote(state), true, 'the receipt must be recordable after completion');

      // A completed deal cannot be released again.
      assert.throws(() => releaseLeg(state, LEG.vehicle, vehicle, ACTORS.seller), /DealCompleted|OverRelease/);
    }),
    { numRuns: 300 },
  );
});

test('invariant 9: refunding BOTH legs closes the deal as cancelled and allows the receipt', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      refundLeg(state, LEG.vehicle);
      assert.equal(state.cancelled, false);
      refundLeg(state, LEG.inspection);
      assert.equal(state.cancelled, true);
      assert.equal(canRecordNote(state), true);
      assert.equal(state.balances.vault, 0n);
    }),
    { numRuns: 300 },
  );
});

test('worked example: a full deal flow stays balanced from start to receipt', () => {
  const state = fresh(45_000_000_000n, 150_000_000n); // 45,000 USDC + 150 USDC
  releaseLeg(state, LEG.inspection, 150_000_000n, ACTORS.inspector);
  releaseLeg(state, LEG.vehicle, 45_000_000_000n, ACTORS.seller);

  assert.equal(remaining(state, LEG.vehicle), 0n);
  assert.equal(remaining(state, LEG.inspection), 0n);
  assert.equal(state.balances[ACTORS.seller], 45_000_000_000n);
  assert.equal(state.balances[ACTORS.inspector], 150_000_000n);
  assert.equal(state.completed, true);
  assert.equal(canRecordNote(state), true, 'the receipt is allowed after the deal completes');
  assert.ok(ledgerSumsToZero(state));
});
