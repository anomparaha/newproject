/**
 * Uji aturan inti VIN. Jalankan: npm test
 *
 * Yang diuji di sini adalah janji-janji di dokumen konsep:
 *  - dana kendaraan tidak cair sebelum syarat serah terima,
 *  - dana inspeksi tidak cair sebelum laporan lengkap,
 *  - anomali kilometer tidak menolak otomatis,
 *  - uang memakai bilangan bulat terskala (bukan float),
 *  - jaminan terpotong masuk kas sengketa.
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

test('uang: konversi minor unit tidak memakai float', () => {
  assert.equal(toMinorUnits('45000', 'USDC'), 45_000_000_000n);
  assert.equal(toMinorUnits('0.1', 'USDC'), 100_000n);
  assert.equal(fromMinorUnits(45_000_000_000n, 'USDC'), '45000.000000');
  assert.equal(toMinorUnits('1250000', 'IDR'), 1_250_000n);
});

test('uang: 0.1 + 0.2 tetap eksak', () => {
  const a = toMinorUnits('0.1', 'USDC');
  const b = toMinorUnits('0.2', 'USDC');
  assert.equal(fromMinorUnits(a + b, 'USDC'), '0.300000');
  assert.equal(compareAmounts('0.3', '0.30', 'USDC'), 0);
});

test('fee: dibulatkan ke bawah dan diskon token tidak menghapus kewajiban', () => {
  assert.equal(bpsFee('45000', 100, 'USDC'), '450.000000');
  assert.equal(feeWithTokenDiscount('45000', 100, 'USDC', false), '450.000000');
  assert.equal(feeWithTokenDiscount('45000', 100, 'USDC', true), '270.000000');
});

test('state machine: dana kendaraan tidak bisa lepas dari status inspecting', () => {
  const result = canTransition('inspecting', 'vehicle_released');
  assert.equal(result.ok, false);
  assert.equal(result.state, 'inspecting');
});

test('state machine: alur normal bisa berjalan sampai completed', () => {
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
    assert.equal(check.ok, true, `${action} seharusnya sah dari ${state}`);
    assert.equal(check.state, expected);
    state = check.state;
  }
  assert.equal(state, 'completed');
});

test('state machine: deal beku menolak langkah lain', () => {
  const blocked = canTransition('frozen', 'vehicle_released');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? '', /arbitrase/i);
  assert.equal(canTransition('frozen', 'arbiter_resolves_refund').ok, true);
});

test('prasyarat: serah terima butuh konfirmasi kedua pihak bila disyaratkan', () => {
  const partial = vehicleReleasePreconditions({
    handoverTerms: 'Serah di lokasi; konfirmasi kedua pihak',
    confirmedBy: ['buyer_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: false,
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, ['konfirmasi_penjual']);

  const complete = vehicleReleasePreconditions({
    handoverTerms: 'Serah di lokasi; konfirmasi kedua pihak',
    confirmedBy: ['buyer_1', 'seller_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: false,
  });
  assert.equal(complete.ok, true);
});

test('prasyarat: sengketa terbuka selalu menahan dana kendaraan', () => {
  const result = vehicleReleasePreconditions({
    handoverTerms: 'Bukti muat',
    confirmedBy: ['buyer_1'],
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    disputeOpen: true,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['sengketa_masih_terbuka']);
});

test('prasyarat: dana inspeksi menunggu laporan lengkap dan penerimaan pembeli', () => {
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

test('anomali kilometer adalah peringatan, bukan penolakan otomatis', () => {
  assert.equal(odometerIsAnomaly(30240, 30000), false);
  assert.equal(odometerIsAnomaly(45000, 68000), true);
  assert.equal(odometerIsAnomaly(45000, null), false);
});

test('jaminan terpotong masuk kas sengketa, bukan dompet tim', () => {
  const breakdown = slashBond('50', 'USDC', 0.5, 0.5);
  assert.equal(breakdown.slashed, '25.000000');
  assert.equal(breakdown.toBuyerCompensation, '12.500000');
  assert.equal(breakdown.toDisputeFund, '12.500000');
  assert.equal(breakdown.returnedToActor, '25.000000');
});
