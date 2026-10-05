/**
 * Core VIN rule tests. Run: npm test
 *
 * These tests cover the promises made in the concept document:
 *  - vehicle funds never release before handover conditions are met,
 *  - inspection funds never release before a complete report,
 *  - an odometer anomaly is a warning, never an automatic rejection,
 *  - money uses scaled integers (never floats),
 *  - a slashed bond goes to the dispute fund.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bpsFee,
  canTransition,
  compareAmounts,
  feeWithTokenDiscount,
  fromMinorUnits,
  inspectionReleasePreconditions,
  odometerIsAnomaly,
  slashBond,
  toMinorUnits,
  vehicleReleasePreconditions,
} from '../dist/index.js';

test('money: minor-unit conversion never touches floats', () => {
  assert.equal(toMinorUnits('45000', 'USDC'), 45_000_000_000n);
  assert.equal(toMinorUnits('0.1', 'USDC'), 100_000n);
  assert.equal(fromMinorUnits(45_000_000_000n, 'USDC'), '45000.000000');
  assert.equal(toMinorUnits('1250000', 'AED'), 125_000_000n);
  assert.equal(fromMinorUnits(125_000_000n, 'AED'), '1250000.00');
});

test('money: 0.1 + 0.2 stays exact', () => {
  const a = toMinorUnits('0.1', 'USDC');
  const b = toMinorUnits('0.2', 'USDC');
  assert.equal(fromMinorUnits(a + b, 'USDC'), '0.300000');
  assert.equal(compareAmounts('0.3', '0.30', 'USDC'), 0);
});

test('fee: rounded down, and a token discount never erases the obligation', () => {
  assert.equal(bpsFee('45000', 100, 'USDC'), '450.000000');
  assert.equal(feeWithTokenDiscount('45000', 100, 'USDC', false), '450.000000');
  assert.equal(feeWithTokenDiscount('45000', 100, 'USDC', true), '270.000000');
});

test('state machine: vehicle funds cannot leave from the inspecting state', () => {
  const result = canTransition('inspecting', 'vehicle_released');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'inspecting');
});

test('state machine: the normal path can run all the way to completed', () => {
  let state = 'draft' as string;
  const flow: Array<[string, string]> = [
    ['buyer_commits_and_funds', 'escrow_pending'],
    ['escrow_funded', 'inspecting'],
    ['buyer_accepts_report', 'inspection_accepted'],
    ['handover_confirmed', 'handover_pending'],
    ['vehicle_released', 'completed'],
  ];
  for (const [action, expected] of flow) {
    const check = canTransition(state as never, action as never);
    assert.equal(check.ok, true, `${action} should be valid from ${state}`);
    assert.equal(check.state, expected);
    state = check.state;
  }
  assert.equal(state, 'completed');
});

test('state machine: a frozen deal rejects every other step', () => {
  const blocked = canTransition('frozen', 'vehicle_released');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? '', /arbitration/i);
  assert.equal(canTransition('frozen', 'arbiter_resolves_refund').ok, true);
});

test('preconditions: handover needs both parties when the terms require it', () => {
  const partial = vehicleReleasePreconditions({
    handoverTerms: 'Handover at location; confirmation by both parties',
    confirmedBy: ['buyer_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: false,
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, ['seller_confirmation']);

  const complete = vehicleReleasePreconditions({
    handoverTerms: 'Handover at location; confirmation by both parties',
    confirmedBy: ['buyer_1', 'seller_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: false,
  });
  assert.equal(complete.ok, true);
});

test('preconditions: an open dispute always holds vehicle funds', () => {
  const result = vehicleReleasePreconditions({
    handoverTerms: 'Load proof',
    confirmedBy: ['buyer_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['dispute_still_open']);
});

test('preconditions: inspection funds wait for a complete report and buyer acceptance', () => {
  const result = inspectionReleasePreconditions({
    reportUploaded: true,
    reportMeetsStandard: true,
    buyerAccepted: false,
    deadlineElapsed: false,
  });
  assert.equal(result.ok, false);
  const accepted = inspectionReleasePreconditions({
    reportUploaded: true,
    reportMeetsStandard: true,
    buyerAccepted: true,
    deadlineElapsed: false,
  });
  assert.equal(accepted.ok, true);
});

test('odometer anomaly is a warning, not an automatic rejection', () => {
  assert.equal(odometerIsAnomaly(30240, 30000), false);
  assert.equal(odometerIsAnomaly(45000, 68000), true);
  assert.equal(odometerIsAnomaly(45000, null), false);
});

test('a slashed bond goes to the dispute fund, not the team wallet', () => {
  const breakdown = slashBond('50', 'USDC', 0.5, 0.5);
  assert.equal(breakdown.slashed, '25.000000');
  assert.equal(breakdown.toBuyerCompensation, '12.500000');
  assert.equal(breakdown.toDisputeFund, '12.500000');
  assert.equal(breakdown.returnedToActor, '25.000000');
});
