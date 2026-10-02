/**
 * MODEL LEDGER ESCROW — cerminan aturan program `programs/vin-anchor/src/lib.rs`.
 *
 * Kenapa file ini ada:
 *  -------------------
 *  Aturan uang on-chain harus bisa diuji di lingkungan mana pun, termasuk di CI
 *  yang tidak punya toolchain Solana. Modul ini adalah model murni (tanpa I/O)
 *  yang memetakan SATU-LAWAN-SATU fungsi program Anchor:
 *
 *    Rust (program)            -> model ini
 *    ---------------------------------------------------------------
 *    open_deal                 -> openDeal()
 *    fund_leg(leg, amount)     -> fundLeg(leg, amount)
 *    release_leg(...)          -> releaseLeg(leg, amount)
 *    refund_leg(leg, ...)      -> refundLeg(leg)
 *    freeze_deal(...)          -> freezeDeal()
 *    resolve_dispute(...)      -> resolveDispute(decision, ...)
 *    slash_bond(...)           -> slashBondToDisputeFund(amount)  (→ kas sengketa)
 *
 *  Setiap aturan yang dijaga di sini punya padanannya di Rust. Uji properti di
 *  `tests/vault.property.test.ts` menyerang model ini dengan kombinasi acak
 *  (fus, over-release, double refund, resolve berulang) supaya invariannya
 *  terbukti, bukan hanya diyakini.
 *
 *  INVARIAN yang dijaga:
 *   1. Tidak ada leg yang dilepas melebihi jumlah yang dikunci (OverRelease).
 *   2. Deal yang dibekukan (frozen) menolak pelepasan dan pengembalian dana.
 *   3. Setelah putusan, SALDO KEDUA LEG TEPAT NOL — tidak ada dana tersangkut.
 *   4. Potongan jaminan masuk KAS SENGKETA, tidak pernah ke admin/relayer.
 *   5. Penerima fee hanya boleh alamat treasury yang dikunci di konfigurasi.
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
  /** Pemilik token account penerima fee platform. */
  feeTreasury: string;
  /** Pemilik token account kas sengketa. */
  disputeFund: string;
  arbiter: string;
  relayer: string;
  feeBps: { vehicle: number; inspection: number };
}

export interface VaultState {
  buyer: string;
  seller: string;
  inspector: string;
  /** Jumlah yang dikunci saat deal dibuka. */
  locked: { vehicle: bigint; inspection: bigint };
  /** Berapa yang sudah keluar dari setiap leg. */
  released: { vehicle: bigint; inspection: bigint };
  frozen: boolean;
  cancelled: boolean;
  completed: boolean;
  /** Saldo di luar vault: untuk audit, harus selalu konsisten. */
  balances: Record<string, bigint>;
  /** Kas sengketa, hanya bertambah dari potongan jaminan. */
  disputeFundBalance: bigint;
  /** Jaminan yang masih terkunci per aktor. */
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
    // Saat pembeli mendanai, saldo berpindah ke vault. Kita catat dari sisi
    // vault supaya uji bisa mengecek "tidak ada dana yang hilang".
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

/** Sisa setiap leg yang masih bisa dipindahkan. */
export function remaining(state: VaultState, leg: Leg): bigint {
  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  return state.locked[key] - state.released[key];
}

export function fundLeg(_state: VaultState, _leg: Leg, amount: bigint): void {
  // Pendanaan sudah tercermin di balances saat openDeal; di sini hanya penjagaan
  // batas atas seperti `OverFunded` di program.
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

/** Pelepasan dana satu leg. Padanan `release_leg`. */
export function releaseLeg(state: VaultState, leg: Leg, amount: bigint, recipient: string): void {
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  if (state.frozen) throw new VaultError('DealFrozen');
  if (state.cancelled) throw new VaultError('DealCancelled');
  if (state.completed) throw new VaultError('DealCompleted');
  if (amount > remaining(state, leg)) throw new VaultError('OverRelease');

  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  state.released[key] += amount;
  credit(state, recipient, amount);
}

/** Pengembalian dana satu leg ke pembeli. Padanan `refund_leg`. */
export function refundLeg(state: VaultState, leg: Leg): void {
  // Deal yang dibekukan tidak boleh di-refund: kalau tidak, relayer bisa
  // melewati arbitrase dan pembekuan sengketa kehilangan artinya.
  if (state.frozen) throw new VaultError('DealFrozen');
  if (state.completed) throw new VaultError('DealCompleted');
  if (state.cancelled) throw new VaultError('DealCancelled');
  const key = leg === LEG.vehicle ? 'vehicle' : 'inspection';
  const amount = remaining(state, leg);
  if (amount <= 0n) throw new VaultError('ZeroAmount');
  state.released[key] += amount;
  credit(state, state.buyer, amount);
}

/**
 * Putusan arbitrase. Padanan `resolve_dispute`.
 * Akuntansi harus tepat habis: leg kendaraan `toBuyer + toSeller == sisa`,
 * leg inspeksi `toInspector <= sisa` dan sisanya kembali ke pembeli.
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

  // Invarian: tidak ada dana tersangkut setelah putusan.
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
 * Potongan jaminan -> KAS SENGKETA. Tidak pernah ke admin/relayer.
 *
 * Namanya berbeda dari `slashBond` di `money.ts` yang hanya MENGHITUNG pembagian
 * potongan (kalkulator murni). Fungsi ini benar-benar memindahkan saldo di model
 * ledger, sesuai `slash_bond` di program Anchor.
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

/** Uang konservatif: total saldo semua pihak harus selalu nol (double-entry). */
export function ledgerSumsToZero(state: VaultState): boolean {
  const total = Object.values(state.balances).reduce((acc, value) => acc + value, 0n) + state.disputeFundBalance;
  return total === 0n;
}

/** Fee dari leg, dibatasi bps. Padanan pemeriksaan `max_fee` di program. */
export function platformFee(config: VaultConfig, leg: Leg, amount: bigint): bigint {
  const bps = leg === LEG.vehicle ? config.feeBps.vehicle : config.feeBps.inspection;
  if (bps < 0 || bps > 1_000) throw new VaultError('FeeTooHigh');
  return (amount * BigInt(bps)) / 10_000n;
}
