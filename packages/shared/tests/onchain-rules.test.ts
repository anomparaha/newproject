/**
 * Uji aturan on-chain hasil rekonsiliasi (lihat docs/SPEC_RECONCILIATION.md).
 *
 * Dua hal yang diuji di sini adalah perbaikan dari spesifikasi lima-kontrak:
 *   - urutan pemanggilan yang sah (di luar urutan = ditolak),
 *   - anomali kilometer dihitung dari state registry, bukan dari server.
 *
 * Jalankan: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import {
  ACTION,
  DEAL_ORDER,
  RuleViolation,
  STAGE,
  acknowledgeAnomaly,
  applyCall,
  assertCallOrder,
  assertCanAcceptReport,
  canRelease,
  confirmDeadline,
  initDealState,
  initVinRecord,
  recordCompletion,
  recordDispute,
  recordInspection,
  recordListing,
  recordReserve,
  recordResolution,
  registryHealth,
  releaseReserve,
  windowElapsedWithoutDispute,
  type Action,
  type CallContext,
  type DealMachineState,
} from '../dist/index.js';

const ctx = (actor: CallContext['actor'], now = '2026-10-03T00:00:00.000Z'): CallContext => ({ actor, now });

/** Urutan yang sah sesuai spesifikasi. */
const HAPPY_PATH: Array<[Action, CallContext['actor']]> = [
  [ACTION.lockStake, 'seller'],
  [ACTION.recordListing, 'seller'],
  [ACTION.createDeal, 'buyer'],
  [ACTION.deposit, 'buyer'],
  [ACTION.fundInspection, 'buyer'],
  [ACTION.submitReport, 'inspector'],
  [ACTION.acceptReport, 'buyer'],
  [ACTION.markHandover, 'seller'],
  [ACTION.confirmHandover, 'buyer'],
  [ACTION.release, 'anyone'],
  [ACTION.mintNote, 'anyone'],
];

// ---------------------------------------------------------------------------
// 1. Urutan pemanggilan
// ---------------------------------------------------------------------------

test('urutan: alur bahagia lengkap berjalan sampai nota', () => {
  let state = initDealState(72);
  for (const [action, actor] of HAPPY_PATH) {
    state = applyCall(state, action, ctx(actor));
  }
  assert.equal(state.stage, STAGE.noted);
  assert.equal(state.noteMinted, true);
});

test('urutan: pemanggilan di luar urutan selalu ditolak', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...(Object.values(ACTION) as Action[])),
      fc.constantFrom(STAGE.kosong, STAGE.staked, STAGE.listed, STAGE.reserved, STAGE.funded, STAGE.handoverMarked, STAGE.released),
      (action, stage) => {
        const state: DealMachineState = { ...initDealState(72), stage };
        const inOrder = DEAL_ORDER[action].from.includes(stage);
        if (!inOrder) {
          // Pemeriksaan urutan dijalankan sebelum pemeriksaan aktor, jadi
          // 'anyone' cukup untuk mengisolasi aturan urutan.
          assert.throws(
            () => applyCall(state, action, ctx('anyone')),
            (error: unknown) => error instanceof RuleViolation && error.code === 'OUT_OF_ORDER',
            `${action} dari tahap ${stage} seharusnya ditolak sebagai OUT_OF_ORDER`,
          );
        }
      },
    ),
    { numRuns: 400 },
  );
});

test('urutan: aktor yang salah ditolak', () => {
  let state = initDealState(72);
  state = applyCall(state, ACTION.lockStake, ctx('seller'));
  state = applyCall(state, ACTION.recordListing, ctx('seller'));
  state = applyCall(state, ACTION.createDeal, ctx('buyer'));
  state = applyCall(state, ACTION.deposit, ctx('buyer'));
  state = applyCall(state, ACTION.fundInspection, ctx('buyer'));
  state = applyCall(state, ACTION.submitReport, ctx('inspector'));
  state = applyCall(state, ACTION.acceptReport, ctx('buyer'));

  // mark_handover hanya penjual; pembeli tidak boleh.
  assert.throws(() => applyCall(state, ACTION.markHandover, ctx('buyer')), /WRONG_ACTOR/);
  // submit_report hanya bengkel.
  const inspecting: DealMachineState = { ...initDealState(72), stage: STAGE.inspecting };
  assert.throws(() => applyCall(inspecting, ACTION.submitReport, ctx('buyer')), /WRONG_ACTOR/);
});

test('urutan: sengketa membekukan alur; hanya arbiter yang boleh memutuskan', () => {
  let state = initDealState(72);
  state = applyCall(state, ACTION.lockStake, ctx('seller'));
  state = applyCall(state, ACTION.recordListing, ctx('seller'));
  state = applyCall(state, ACTION.createDeal, ctx('buyer'));
  state = applyCall(state, ACTION.deposit, ctx('buyer'));
  state = applyCall(state, ACTION.openDispute, ctx('buyer'));

  // Semua langkah normal ditolak selama sengketa.
  assert.throws(() => applyCall(state, ACTION.fundInspection, ctx('buyer')), /DISPUTE_OPEN/);
  assert.throws(() => applyCall(state, ACTION.release, ctx('anyone')), /DISPUTE_OPEN/);
  assert.throws(() => applyCall(state, ACTION.resolveDispute, ctx('buyer')), /WRONG_ACTOR/);

  state = applyCall(state, ACTION.resolveDispute, ctx('arbiter'));
  assert.equal(state.stage, STAGE.resolved);
  assert.equal(state.disputeOpen, false);
  // Setelah diputus, alur normal tidak bisa dilanjutkan dari tahap resolved.
  assert.throws(() => applyCall(state, ACTION.release, ctx('anyone')), /OUT_OF_ORDER/);
});

test('urutan: nota tidak bisa dicetak dua kali', () => {
  const released: DealMachineState = { ...initDealState(72), stage: STAGE.released, noteMinted: true };
  assert.throws(() => applyCall(released, ACTION.mintNote, ctx('anyone')), /NOTE_EXISTS/);
});

test('urutan: sengketa hanya bisa dibuka setelah dana masuk', () => {
  for (const stage of [STAGE.kosong, STAGE.staked, STAGE.listed, STAGE.reserved]) {
    const state: DealMachineState = { ...initDealState(72), stage };
    assert.throws(() => applyCall(state, ACTION.openDispute, ctx('buyer')), /OUT_OF_ORDER/);
  }
});

// ---------------------------------------------------------------------------
// 2. Jendela konfirmasi (pembeli yang diam tidak menahan dana selamanya)
// ---------------------------------------------------------------------------

test('jendela konfirmasi: pembeli diam -> release tetap sah setelah jendela lewat', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 240 }), fc.integer({ min: 0, max: 240 }), (windowHours, hoursLater) => {
      const markedAt = '2026-10-03T00:00:00.000Z';
      const state: DealMachineState = {
        ...initDealState(windowHours),
        stage: STAGE.handoverMarked,
        handoverMarkedAt: markedAt,
      };
      const now = new Date(Date.parse(markedAt) + hoursLater * 3_600_000).toISOString();
      const elapsed = hoursLater >= windowHours;
      assert.equal(windowElapsedWithoutDispute(state, now), elapsed);
      const result = canRelease(state, now);
      assert.equal(result.ok, elapsed, `ok seharusnya ${elapsed}, dapat ${result.reason}`);
      if (elapsed) assert.equal(result.reason, 'jendela_konfirmasi_lewat_tanpa_sengketa');
    }),
    { numRuns: 300 },
  );
});

test('jendela konfirmasi: sengketa menahan release walau jendela lewat', () => {
  const state: DealMachineState = {
    ...initDealState(24),
    stage: STAGE.frozen,
    handoverMarkedAt: '2026-10-03T00:00:00.000Z',
    disputeOpen: true,
  };
  const later = '2026-10-10T00:00:00.000Z';
  assert.equal(windowElapsedWithoutDispute(state, later), false);
  assert.equal(canRelease(state, later).ok, false);
  assert.equal(canRelease(state, later).reason, 'sengketa_terbuka');
});

test('jendela konfirmasi: deadline dihitung dari markHandover', () => {
  const state: DealMachineState = { ...initDealState(48), stage: STAGE.handoverMarked, handoverMarkedAt: '2026-10-03T00:00:00.000Z' };
  assert.equal(confirmDeadline(state), '2026-10-05T00:00:00.000Z');
  assert.equal(confirmDeadline(initDealState(48)), null);
});

// ---------------------------------------------------------------------------
// 3. Registry: anomali dihitung on-chain
// ---------------------------------------------------------------------------

test('registry: reserve kedua untuk VIN yang sama ditolak', () => {
  let record = initVinRecord('vin_hash_a', 'seller_1');
  record = recordListing(record, 'seller_1');
  record = recordReserve(record, 'deal_1');
  assert.throws(() => recordReserve(record, 'deal_2'), /ALREADY_RESERVED/);
  record = releaseReserve(record, 'deal_1');
  record = recordReserve(record, 'deal_2');
  assert.equal(record.reservedByDeal, 'deal_2');
});

test('registry: anomali dihitung dari titik tertinggi, bukan angka terakhir', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 1, maxLength: 25 }), (readings) => {
      let record = initVinRecord('vin_hash_b', 'seller_1');
      record = recordListing(record, 'seller_1');
      record = recordReserve(record, 'deal_1');

      let expectedAnomalies = 0;
      let runningMax = -1;
      for (const [index, odometerKm] of readings.entries()) {
        const { record: next, anomaly } = recordInspection(record, {
          dealId: 'deal_1',
          odometerKm,
          reportHash: `hash_${index}`,
          at: `2026-10-03T0${index % 10}:00:00.000Z`,
        });
        const expected = runningMax >= 0 && odometerKm < runningMax;
        assert.equal(anomaly, expected, `anomali salah pada pembacaan ${odometerKm} (max ${runningMax})`);
        if (expected) expectedAnomalies += 1;
        runningMax = Math.max(runningMax, odometerKm);
        record = next;
      }

      assert.equal(record.anomalies.length, expectedAnomalies);
      assert.equal(record.maxOdometer, runningMax);
      assert.equal(record.lastOdometer, readings[readings.length - 1]);
      // Titik tertinggi tidak pernah turun, walau laporan terakhir lebih rendah.
      assert.ok((record.maxOdometer ?? 0) >= (record.lastOdometer ?? 0));
    }),
    { numRuns: 250 },
  );
});

test('registry: laporan rendah tidak boleh mereset dasar pembanding', () => {
  let record = initVinRecord('vin_hash_c', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 80_000, reportHash: 'h1', at: '2026-10-03T00:00:00.000Z' }).record;
  // Laporan curang: odometer turun drastis.
  const forged = recordInspection(record, { dealId: 'deal_1', odometerKm: 30_000, reportHash: 'h2', at: '2026-10-03T01:00:00.000Z' });
  assert.equal(forged.anomaly, true);
  assert.equal(forged.record.maxOdometer, 80_000, 'max tidak boleh turun ke 30.000');
  // Laporan berikutnya tetap dibandingkan ke 80.000, bukan 30.000.
  const third = recordInspection(forged.record, { dealId: 'deal_1', odometerKm: 50_000, reportHash: 'h3', at: '2026-10-03T02:00:00.000Z' });
  assert.equal(third.anomaly, true, '50.000 masih di bawah titik tertinggi 80.000');
});

test('registry: laporan tidak bisa diterima selama anomali belum dilihat pembeli', () => {
  let record = initVinRecord('vin_hash_d', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 60_000, reportHash: 'h1', at: '2026-10-03T00:00:00.000Z' }).record;
  const anomalous = recordInspection(record, { dealId: 'deal_1', odometerKm: 40_000, reportHash: 'h2', at: '2026-10-03T01:00:00.000Z' });
  assert.equal(anomalous.anomaly, true);
  assert.equal(anomalous.record.anomalyPending, true);
  assert.throws(() => assertCanAcceptReport(anomalous.record), /ANOMALY_PENDING/);

  const acknowledged = acknowledgeAnomaly(anomalous.record, 'buyer');
  assert.equal(acknowledged.anomalyPending, false);
  assert.doesNotThrow(() => assertCanAcceptReport(acknowledged));
  // Catatan anomali tetap ada selamanya - tidak dihapus oleh pengakuan.
  assert.equal(acknowledged.anomalies.length, 1);
  assert.equal(acknowledged.anomalies[0]?.previousMax, 60_000);
});

test('registry: hanya pembeli yang boleh mengakui peringatan anomali', () => {
  let record = initVinRecord('vin_hash_e', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 10_000, reportHash: 'h1', at: '2026-10-03T00:00:00.000Z' }).record;
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 5_000, reportHash: 'h2', at: '2026-10-03T01:00:00.000Z' }).record;
  assert.throws(() => acknowledgeAnomaly(record, 'not_buyer' as 'buyer'), /WRONG_ACTOR/);
});

test('registry: append-only - jumlah event tidak pernah berhenti bertambah', () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 1, max: 99_999 }), { minLength: 1, maxLength: 15 }), (readings) => {
      let record = initVinRecord('vin_hash_f', 'seller_1');
      let previousEvents = record.events;
      const steps: Array<() => void> = [
        () => {
          record = recordListing(record, 'seller_1');
        },
        () => {
          record = recordReserve(record, 'deal_1');
        },
        ...readings.map((odometerKm, index) => () => {
          record = recordInspection(record, {
            dealId: 'deal_1',
            odometerKm,
            reportHash: `h${index}`,
            at: '2026-10-03T00:00:00.000Z',
          }).record;
        }),
        () => {
          record = recordDispute(record, 'deal_1');
        },
        () => {
          record = recordResolution(record);
        },
        () => {
          record = recordCompletion(record, 'deal_1');
        },
      ];
      for (const step of steps) {
        step();
        assert.ok(record.events > previousEvents, 'event harus selalu bertambah');
        previousEvents = record.events;
      }
      assert.equal(record.events, steps.length);
    }),
    { numRuns: 150 },
  );
});

test('registry: sengketa & resolusi tercatat, dan health dihitung dari registry', () => {
  let record = initVinRecord('vin_hash_g', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  assert.throws(() => recordResolution(record), /NO_DISPUTE/);
  record = recordDispute(record, 'deal_1');
  assert.equal(record.disputeOpen, true);
  assert.throws(() => recordCompletion(record, 'deal_1'), /DISPUTE_OPEN/);
  record = recordResolution(record);
  assert.equal(record.disputeOpen, false);
  record = recordCompletion(record, 'deal_1');
  assert.equal(record.completionRecorded, true);

  const health = registryHealth([record, initVinRecord('vin_hash_h', 'seller_2')]);
  assert.equal(health.total, 2);
  assert.equal(health.disputed, 0);
});

test('registry: laporan untuk deal yang tidak memegang reserve ditolak', () => {
  let record = initVinRecord('vin_hash_i', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  assert.throws(
    () => recordInspection(record, { dealId: 'deal_lain', odometerKm: 1000, reportHash: 'h', at: '2026-10-03T00:00:00.000Z' }),
    /NOT_RESERVED_BY_DEAL/,
  );
});

test('registry: listing tidak bisa didaftarkan dua kali untuk vinHash yang sama', () => {
  const record = recordListing(initVinRecord('vin_hash_j', 'seller_1'), 'seller_1');
  assert.throws(() => recordListing(record, 'seller_1'), /LISTING_EXISTS/);
  assert.throws(() => recordListing(initVinRecord('vin_hash_k', 'seller_1'), 'seller_2'), /WRONG_SELLER/);
});

test('urutan: assertCallOrder mengembalikan aturan yang berlaku untuk audit', () => {
  const rule = assertCallOrder(initDealState(72), ACTION.lockStake, ctx('seller'));
  assert.equal(rule.to, STAGE.staked);
  assert.equal(rule.actor, 'seller');
});
