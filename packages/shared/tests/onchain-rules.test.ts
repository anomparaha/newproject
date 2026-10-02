/**
 * Tests for the reconciled on-chain rules (see docs/SPEC_RECONCILIATION.md).
 *
 * The two things tested here are the fixes taken from the five-contract spec:
 *   - valid call order (anything out of order is rejected),
 *   - odometer anomalies computed from registry state, not from the server.
 *
 * Run: npm test
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

/** The valid order from the design spec. */
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
// 1. Call order
// ---------------------------------------------------------------------------

test('order: the full happy path runs through to the receipt', () => {
  let state = initDealState(72);
  for (const [action, actor] of HAPPY_PATH) {
    state = applyCall(state, action, ctx(actor));
  }
  assert.equal(state.stage, STAGE.noted);
  assert.equal(state.noteMinted, true);
});

test('order: any call outside the valid order is rejected', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...(Object.values(ACTION) as Action[])),
      fc.constantFrom(STAGE.empty, STAGE.staked, STAGE.listed, STAGE.reserved, STAGE.funded, STAGE.handoverMarked, STAGE.released),
      (action, stage) => {
        const state: DealMachineState = { ...initDealState(72), stage };
        const inOrder = DEAL_ORDER[action].from.includes(stage);
        if (!inOrder) {
          // The order check runs before the actor check, so 'anyone' is enough to
          // isolate the ordering rule.
          assert.throws(
            () => applyCall(state, action, ctx('anyone')),
            (error: unknown) => error instanceof RuleViolation && error.code === 'OUT_OF_ORDER',
            `${action} from stage ${stage} should be rejected as OUT_OF_ORDER`,
          );
        }
      },
    ),
    { numRuns: 400 },
  );
});

test('order: the wrong actor is rejected', () => {
  let state = initDealState(72);
  state = applyCall(state, ACTION.lockStake, ctx('seller'));
  state = applyCall(state, ACTION.recordListing, ctx('seller'));
  state = applyCall(state, ACTION.createDeal, ctx('buyer'));
  state = applyCall(state, ACTION.deposit, ctx('buyer'));
  state = applyCall(state, ACTION.fundInspection, ctx('buyer'));
  state = applyCall(state, ACTION.submitReport, ctx('inspector'));
  state = applyCall(state, ACTION.acceptReport, ctx('buyer'));

  // mark_handover is seller-only; the buyer must not run it.
  assert.throws(() => applyCall(state, ACTION.markHandover, ctx('buyer')), /WRONG_ACTOR/);
  // submit_report is workshop-only.
  const inspecting: DealMachineState = { ...initDealState(72), stage: STAGE.inspecting };
  assert.throws(() => applyCall(inspecting, ACTION.submitReport, ctx('buyer')), /WRONG_ACTOR/);
});

test('order: a dispute freezes the flow; only the arbiter may rule', () => {
  let state = initDealState(72);
  state = applyCall(state, ACTION.lockStake, ctx('seller'));
  state = applyCall(state, ACTION.recordListing, ctx('seller'));
  state = applyCall(state, ACTION.createDeal, ctx('buyer'));
  state = applyCall(state, ACTION.deposit, ctx('buyer'));
  state = applyCall(state, ACTION.openDispute, ctx('buyer'));

  // Every normal step is rejected while the dispute is open.
  assert.throws(() => applyCall(state, ACTION.fundInspection, ctx('buyer')), /DISPUTE_OPEN/);
  assert.throws(() => applyCall(state, ACTION.release, ctx('anyone')), /DISPUTE_OPEN/);
  assert.throws(() => applyCall(state, ACTION.resolveDispute, ctx('buyer')), /WRONG_ACTOR/);

  state = applyCall(state, ACTION.resolveDispute, ctx('arbiter'));
  assert.equal(state.stage, STAGE.resolved);
  assert.equal(state.disputeOpen, false);
  // After the ruling the normal path cannot resume from the resolved stage.
  assert.throws(() => applyCall(state, ACTION.release, ctx('anyone')), /OUT_OF_ORDER/);
});

test('order: a receipt cannot be minted twice', () => {
  const released: DealMachineState = { ...initDealState(72), stage: STAGE.released, noteMinted: true };
  assert.throws(() => applyCall(released, ACTION.mintNote, ctx('anyone')), /NOTE_EXISTS/);
});

test('order: a dispute can only open after funds are in', () => {
  for (const stage of [STAGE.empty, STAGE.staked, STAGE.listed, STAGE.reserved]) {
    const state: DealMachineState = { ...initDealState(72), stage };
    assert.throws(() => applyCall(state, ACTION.openDispute, ctx('buyer')), /OUT_OF_ORDER/);
  }
});

// ---------------------------------------------------------------------------
// 2. Confirmation window (a silent buyer must not hold funds forever)
// ---------------------------------------------------------------------------

test('confirmation window: a silent buyer still lets release through once the window passes', () => {
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
      assert.equal(result.ok, elapsed, `ok should be ${elapsed}, got ${result.reason}`);
      if (elapsed) assert.equal(result.reason, 'confirm_window_elapsed_without_dispute');
    }),
    { numRuns: 300 },
  );
});

test('confirmation window: a dispute holds release even after the window passes', () => {
  const state: DealMachineState = {
    ...initDealState(24),
    stage: STAGE.frozen,
    handoverMarkedAt: '2026-10-03T00:00:00.000Z',
    disputeOpen: true,
  };
  const later = '2026-10-10T00:00:00.000Z';
  assert.equal(windowElapsedWithoutDispute(state, later), false);
  assert.equal(canRelease(state, later).ok, false);
  assert.equal(canRelease(state, later).reason, 'dispute_open');
});

test('confirmation window: the deadline is counted from markHandover', () => {
  const state: DealMachineState = { ...initDealState(48), stage: STAGE.handoverMarked, handoverMarkedAt: '2026-10-03T00:00:00.000Z' };
  assert.equal(confirmDeadline(state), '2026-10-05T00:00:00.000Z');
  assert.equal(confirmDeadline(initDealState(48)), null);
});

// ---------------------------------------------------------------------------
// 3. Registry: anomalies computed on-chain
// ---------------------------------------------------------------------------

test('registry: a second reserve for the same VIN is rejected', () => {
  let record = initVinRecord('vin_hash_a', 'seller_1');
  record = recordListing(record, 'seller_1');
  record = recordReserve(record, 'deal_1');
  assert.throws(() => recordReserve(record, 'deal_2'), /ALREADY_RESERVED/);
  record = releaseReserve(record, 'deal_1');
  record = recordReserve(record, 'deal_2');
  assert.equal(record.reservedByDeal, 'deal_2');
});

test('registry: anomalies are computed from the high-water mark, not the last reading', () => {
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
        assert.equal(anomaly, expected, `wrong anomaly verdict for reading ${odometerKm} (max ${runningMax})`);
        if (expected) expectedAnomalies += 1;
        runningMax = Math.max(runningMax, odometerKm);
        record = next;
      }

      assert.equal(record.anomalies.length, expectedAnomalies);
      assert.equal(record.maxOdometer, runningMax);
      assert.equal(record.lastOdometer, readings[readings.length - 1]);
      // The high-water mark never drops, even when the latest report is lower.
      assert.ok((record.maxOdometer ?? 0) >= (record.lastOdometer ?? 0));
    }),
    { numRuns: 250 },
  );
});

test('registry: a low report cannot reset the anomaly baseline', () => {
  let record = initVinRecord('vin_hash_c', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 80_000, reportHash: 'h1', at: '2026-10-03T00:00:00.000Z' }).record;
  // A forged report: the odometer drops sharply.
  const forged = recordInspection(record, { dealId: 'deal_1', odometerKm: 30_000, reportHash: 'h2', at: '2026-10-03T01:00:00.000Z' });
  assert.equal(forged.anomaly, true);
  assert.equal(forged.record.maxOdometer, 80_000, 'the high-water mark must not fall to 30,000');
  // The next report is still compared against 80,000, not 30,000.
  const third = recordInspection(forged.record, { dealId: 'deal_1', odometerKm: 50_000, reportHash: 'h3', at: '2026-10-03T02:00:00.000Z' });
  assert.equal(third.anomaly, true, '50,000 is still below the 80,000 high-water mark');
});

test('registry: a report cannot be accepted while the buyer has not seen the anomaly', () => {
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
  // The anomaly log stays forever — acknowledging does not delete it.
  assert.equal(acknowledged.anomalies.length, 1);
  assert.equal(acknowledged.anomalies[0]?.previousMax, 60_000);
});

test('registry: only the buyer may acknowledge an anomaly warning', () => {
  let record = initVinRecord('vin_hash_e', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 10_000, reportHash: 'h1', at: '2026-10-03T00:00:00.000Z' }).record;
  record = recordInspection(record, { dealId: 'deal_1', odometerKm: 5_000, reportHash: 'h2', at: '2026-10-03T01:00:00.000Z' }).record;
  assert.throws(() => acknowledgeAnomaly(record, 'not_buyer' as 'buyer'), /WRONG_ACTOR/);
});

test('registry: append-only — the event count never stops growing', () => {
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
        assert.ok(record.events > previousEvents, 'the event count must always grow');
        previousEvents = record.events;
      }
      assert.equal(record.events, steps.length);
    }),
    { numRuns: 150 },
  );
});

test('registry: disputes and resolutions are recorded, and health is computed from the registry', () => {
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

test('registry: a report for a deal that does not hold the reserve is rejected', () => {
  let record = initVinRecord('vin_hash_i', 'seller_1');
  record = recordReserve(recordListing(record, 'seller_1'), 'deal_1');
  assert.throws(
    () => recordInspection(record, { dealId: 'other_deal', odometerKm: 1000, reportHash: 'h', at: '2026-10-03T00:00:00.000Z' }),
    /NOT_RESERVED_BY_DEAL/,
  );
});

test('registry: a listing cannot be registered twice for the same vinHash', () => {
  const record = recordListing(initVinRecord('vin_hash_j', 'seller_1'), 'seller_1');
  assert.throws(() => recordListing(record, 'seller_1'), /LISTING_EXISTS/);
  assert.throws(() => recordListing(initVinRecord('vin_hash_k', 'seller_1'), 'seller_2'), /WRONG_SELLER/);
});

test('order: assertCallOrder returns the rule in force, for audit', () => {
  const rule = assertCallOrder(initDealState(72), ACTION.lockStake, ctx('seller'));
  assert.equal(rule.to, STAGE.staked);
  assert.equal(rule.actor, 'seller');
});
