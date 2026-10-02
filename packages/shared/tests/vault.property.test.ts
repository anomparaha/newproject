/**
 * Uji PROPERTI untuk model ledger escrow (cerminan aturan program Anchor).
 *
 * Cara kerja: fast-check membangkitkan ribuan kombinasi acak (jumlah dana, urutan
 * aksi, percobaan curang) dan setelah setiap urutan kita memeriksa invarian.
 * Jadi yang diuji bukan hanya "satu skenario yang saya pikirkan", tetapi ruang
 * besar kemungkinan — inilah pengganti paling dekat dengan fuzzing program
 * on-chain yang bisa dijalankan tanpa toolchain Solana.
 *
 * Jalankan: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  DECISION,
  LEG,
  VaultError,
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

test('invarian 1: pelepasan tidak pernah melebihi jumlah yang dikunci', () => {
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
          'pelepasan leg kendaraan melebihi jumlah terkunci',
        );
      }
      assert.equal(state.released.vehicle, releasedTotal);
    }),
    { numRuns: 500 },
  );
});

test('invarian 2: deal yang dibekukan menolak pelepasan dan pengembalian dana', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.bigInt({ min: 1n, max: 1_000_000n }), (vehicle, inspection, amount) => {
      const state = fresh(vehicle, inspection);
      freezeDeal(state, ACTORS.buyer);

      assert.throws(() => releaseLeg(state, LEG.vehicle, amount, ACTORS.seller), /DealFrozen/);
      assert.throws(() => refundLeg(state, LEG.inspection), /DealFrozen|DealCancelled/);
      // Dana tetap utuh di vault selama beku.
      assert.equal(state.released.vehicle, 0n);
      assert.equal(state.released.inspection, 0n);
    }),
    { numRuns: 300 },
  );
});

test('invarian 3: setelah putusan, saldo kedua leg tepat nol (tidak ada dana tersangkut)', () => {
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
        assert.equal(state.balances.vault, 0n, 'vault harus kosong setelah putusan');
        assert.equal(state.balances[ACTORS.inspector], toInspector);
        assert.ok(ledgerSumsToZero(state), 'pembukuan ganda harus selalu nol');
      },
    ),
    { numRuns: 500 },
  );
});

test('invarian 3b: pembagian yang tidak tepat habis DITOLAK (dana tidak boleh tersangkut)', () => {
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

test('invarian 4: potongan jaminan selalu masuk kas sengketa, bukan admin/relayer', () => {
  fc.assert(
    fc.property(amountArb, amountArb, fc.bigInt({ min: 1n, max: 1_000_000n }), (vehicle, inspection, bondAmount) => {
      const state = fresh(vehicle, inspection);
      lockBond(state, ACTORS.seller, bondAmount);
      // 1..bondAmount (tidak pernah melebihi jaminan yang terkunci)
      const slashAmount = ((bondAmount - 1n) % 1_000_000n) + 1n;

      slashBondToDisputeFund(state, CONFIG, CONFIG.arbiter, ACTORS.seller, slashAmount);

      assert.equal(state.disputeFundBalance, slashAmount);
      assert.equal(state.balances[CONFIG.disputeFund], slashAmount);
      assert.equal(state.balances['admin'] ?? 0n, 0n, 'admin tidak boleh menerima potongan jaminan');
      assert.equal(state.balances[CONFIG.relayer] ?? 0n, 0n, 'relayer tidak boleh menerima potongan jaminan');
      assert.equal(state.bonds[ACTORS.seller], bondAmount - slashAmount);
    }),
    { numRuns: 300 },
  );
});

test('invarian 5: hanya arbiter yang boleh memutuskan; hanya pihak deal yang boleh membekukan', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      assert.throws(() => freezeDeal(state, 'orang_luar'), /Unauthorized/);
      freezeDeal(state, ACTORS.inspector);
      assert.throws(
        () =>
          resolveDispute(state, CONFIG, 'bukan_arbiter', {
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

test('invarian 6: refund ganda ditolak (dana tidak bisa dikembalikan dua kali)', () => {
  fc.assert(
    fc.property(amountArb, amountArb, (vehicle, inspection) => {
      const state = fresh(vehicle, inspection);
      refundLeg(state, LEG.vehicle);
      assert.equal(state.released.vehicle, state.locked.vehicle);
      assert.throws(() => refundLeg(state, LEG.vehicle), /DealCancelled|ZeroAmount|DealCompleted/);
      // Leg inspeksi tidak boleh ikut terpengaruh.
      assert.equal(state.released.inspection, 0n);
    }),
    { numRuns: 300 },
  );
});

test('invarian 7: fee dibatasi bps dan pembukuan tetap seimbang', () => {
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

test('contoh nyata: alur deal lengkap tetap seimbang dari awal sampai nota', () => {
  const state = fresh(45_000_000_000n, 150_000_000n); // 45.000 USDC + 150 USDC
  releaseLeg(state, LEG.inspection, 150_000_000n, ACTORS.inspector);
  releaseLeg(state, LEG.vehicle, 45_000_000_000n, ACTORS.seller);

  assert.equal(remaining(state, LEG.vehicle), 0n);
  assert.equal(remaining(state, LEG.inspection), 0n);
  assert.equal(state.balances[ACTORS.seller], 45_000_000_000n);
  assert.equal(state.balances[ACTORS.inspector], 150_000_000n);
  assert.ok(ledgerSumsToZero(state));
});
