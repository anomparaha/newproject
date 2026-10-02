/**
 * ATURAN ON-CHAIN (versi rekonsiliasi)
 * ====================================
 *
 * Model yang mengkodekan dua perbaikan dari spesifikasi rancangan lima-kontrak
 * (lihat `docs/SPEC_RECONCILIATION.md`), supaya aturannya bisa dijalankan dan
 * diuji SEBELUM ditulis ke Rust:
 *
 *   1. URUTAN PEMANGGILAN YANG SAH — state machine eksplisit. Pemanggilan di
 *      luar urutan ditolak (padanan "harus revert" di EVM).
 *
 *   2. REGISTRY VIN + ANOMALI DIHITUNG ON-CHAIN — registry menyimpan
 *      `max_odometer` per vinHash, sehingga anomali kilometer dihitung dari
 *      state on-chain, bukan dari server. Server hanya boleh MENAMPILKAN; ia
 *      tidak bisa menyembunyikan selisih karena ambangnya dihitung di sini.
 *
 * Catatan penting soal odometer: kalau kita menyimpan hanya "angka terakhir",
 * satu laporan rendah akan mereset dasar pembanding dan anomali berikutnya
 * hilang. Karena itu registry menyimpan DUA angka:
 *   - `lastOdometer`  : pembacaan terbaru (untuk tampilan riwayat)
 *   - `maxOdometer`   : titik tertinggi yang pernah tercatat (dasar anomali)
 * Anomali = `odometer < maxOdometer`.
 *
 * File ini murni (tanpa I/O) dan dipakai bersama API, pengujian, dan saat
 * menulis instruksi Rust. Padanan Rust yang akan ditambahkan ke program:
 * `init_vin_record`, `record_listing`, `record_reserve`, `record_inspection`,
 * `acknowledge_anomaly`, `record_completion`, `record_dispute`,
 * `record_resolution`, dan enum `DealState` pada `DealAccount`.
 */

export class RuleViolation extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    // Pesan selalu berawalan kode aturan supaya log on-chain/off-chain mudah
    // dicocokkan dengan tabel aturan di dokumentasi.
    super(message ? `${code}: ${message}` : code);
  }
}

// ---------------------------------------------------------------------------
// 1. URUTAN PEMANGGILAN YANG SAH
// ---------------------------------------------------------------------------

/**
 * Tahap deal. Angka dipakai apa adanya supaya urutannya terlihat jelas dan
 * bisa dibandingkan (`>` / `<`), seperti enum di on-chain.
 */
export const STAGE = {
  kosong: 0,
  /** Jaminan penjual/bengkel terkunci di StakeVault. */
  staked: 1,
  /** recordListing: listing terdaftar di registry. */
  listed: 2,
  /** createDeal: listing menjadi reserved, dealId dibuat. */
  reserved: 3,
  /** deposit: stablecoin harga unit masuk escrow kendaraan. */
  funded: 4,
  /** fundInspection: biaya bengkel masuk escrow inspeksi. */
  inspecting: 5,
  /** submitReport: laporan bengkel (hash + kilometer). */
  reportSubmitted: 6,
  /** acceptReport: pembeli menerima; dana inspeksi lepas ke bengkel. */
  reportAccepted: 7,
  /** markHandover: penjual melampirkan proofHash. */
  handoverMarked: 8,
  /** confirmHandover: pembeli mengonfirmasi (atau jendela lewat tanpa sengketa). */
  handoverConfirmed: 9,
  /** release: dana kendaraan lepas ke penjual setelah fee. */
  released: 10,
  /** mintNote: nota diterbitkan. */
  noted: 11,
  /** openDispute menghentikan alur normal. */
  frozen: 90,
  /** resolve: putusan arbitrase. */
  resolved: 91,
} as const;

export type Stage = (typeof STAGE)[keyof typeof STAGE];

/** Cabang sengketa boleh dibuka dari tahap mana pun setelah dana masuk. */
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
  /** Siapa yang boleh memicu (padanan pemeriksaan signer di Rust). */
  actor: 'seller' | 'buyer' | 'inspector' | 'operator' | 'arbiter' | 'anyone';
}

/**
 * Tabel urutan sah. Instruksi di luar tabel ini ditolak.
 *
 * Perhatikan `release`: sesuai spesifikasi Anda, ia TIDAK butuh relayer —
 * cukup pihak mana pun memanggil setelah syarat terbukti. Ini menghapus titik
 * kepercayaan "hot key platform" yang ada di desain lama.
 */
export const DEAL_ORDER: Record<Action, TransitionRule> = {
  lock_stake: { from: [STAGE.kosong], to: STAGE.staked, actor: 'seller' },
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
  /** Jendela konfirmasi pembeli (jam) setelah markHandover. */
  confirmWindowHours: number;
  handoverMarkedAt: string | null;
  /** Kasus sengketa terbuka menahan semua perpindahan dana. */
  disputeOpen: boolean;
  /** Nota sudah pernah dicetak? Nota tidak boleh ditimpa. */
  noteMinted: boolean;
}

export function initDealState(confirmWindowHours = 72): DealMachineState {
  return {
    stage: STAGE.kosong,
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
 * Memeriksa apakah sebuah aksi sah pada tahap sekarang.
 * Menolak (throw) di luar urutan — padanan `revert` di EVM.
 */
export function assertCallOrder(state: DealMachineState, action: Action, ctx: CallContext): TransitionRule {
  const rule = DEAL_ORDER[action];
  if (!rule) throw new RuleViolation('UNKNOWN_ACTION', `Aksi tidak dikenal: ${action}`);

  if (state.disputeOpen && action !== ACTION.resolveDispute && action !== ACTION.openDispute) {
    throw new RuleViolation('DISPUTE_OPEN', `Deal dibekukan sengketa; "${action}" tidak bisa dijalankan.`);
  }
  if (!rule.from.includes(state.stage)) {
    throw new RuleViolation(
      'OUT_OF_ORDER',
      `"${action}" tidak sah pada tahap ${state.stage}; harus dari ${rule.from.join(' atau ')}.`,
    );
  }
  if (rule.actor !== 'anyone' && rule.actor !== ctx.actor) {
    throw new RuleViolation('WRONG_ACTOR', `"${action}" hanya boleh dipicu ${rule.actor}, bukan ${ctx.actor}.`);
  }
  if (action === ACTION.mintNote && state.noteMinted) {
    throw new RuleViolation('NOTE_EXISTS', 'Nota sudah pernah dicetak untuk deal ini.');
  }
  return rule;
}

/** Terapkan aksi yang sudah lolos pemeriksaan. */
export function applyCall(state: DealMachineState, action: Action, ctx: CallContext): DealMachineState {
  const rule = assertCallOrder(state, action, ctx);
  const next: DealMachineState = { ...state, stage: rule.to };
  if (action === ACTION.markHandover) next.handoverMarkedAt = ctx.now;
  if (action === ACTION.openDispute) next.disputeOpen = true;
  if (action === ACTION.resolveDispute) next.disputeOpen = false;
  if (action === ACTION.mintNote) next.noteMinted = true;
  return next;
}

/** Deadline konfirmasi pembeli (ISO) atau null bila handover belum ditandai. */
export function confirmDeadline(state: DealMachineState): string | null {
  if (!state.handoverMarkedAt) return null;
  return new Date(Date.parse(state.handoverMarkedAt) + state.confirmWindowHours * 3_600_000).toISOString();
}

/**
 * Jendela konfirmasi lewat tanpa sengketa: pembeli yang diam tidak boleh
 * menahan dana selamanya. Dengan aturan ini, `release` menjadi sah meski
 * `confirm_handover` tidak pernah dipanggil — tetapi hanya bila jendela lewat
 * DAN tidak ada sengketa.
 */
export function windowElapsedWithoutDispute(state: DealMachineState, now: string): boolean {
  const deadline = confirmDeadline(state);
  if (!deadline) return false;
  return !state.disputeOpen && Date.parse(now) >= Date.parse(deadline);
}

export function canRelease(state: DealMachineState, now: string): { ok: boolean; reason: string } {
  if (state.disputeOpen) return { ok: false, reason: 'sengketa_terbuka' };
  if (state.stage === STAGE.handoverConfirmed) return { ok: true, reason: 'dikonfirmasi_pembeli' };
  if (state.stage === STAGE.handoverMarked && windowElapsedWithoutDispute(state, now)) {
    return { ok: true, reason: 'jendela_konfirmasi_lewat_tanpa_sengketa' };
  }
  if (state.stage === STAGE.frozen) return { ok: false, reason: 'menunggu_putusan_arbiter' };
  return { ok: false, reason: `tahap_${state.stage}_belum_siap` };
}

// ---------------------------------------------------------------------------
// 2. REGISTRY VIN + ANOMALI DIHITUNG ON-CHAIN
// ---------------------------------------------------------------------------

export interface VinRegistryRecord {
  /** Kunci registry: hash VIN yang dinormalisasi, bukan VIN mentah. */
  vinHash: string;
  seller: string;
  /** Pembacaan terbaru (tampilan riwayat). */
  lastOdometer: number | null;
  /** Titik tertinggi yang pernah tercatat — DASAR perhitungan anomali. */
  maxOdometer: number | null;
  /** Jumlah event yang pernah ditulis; hanya bisa bertambah. */
  events: number;
  /** Anomali menunggu dilihat pembeli sebelum laporan boleh diterima. */
  anomalyPending: boolean;
  /** Catatan anomali permanen: tidak pernah bisa dihapus. */
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
  // Append-only: jumlah event hanya bertambah, tidak ada penghapusan.
  return { ...record, events: record.events + 1 };
}

export function recordListing(record: VinRegistryRecord, seller: string): VinRegistryRecord {
  if (record.listingRecorded) throw new RuleViolation('LISTING_EXISTS', 'Listing untuk vinHash ini sudah tercatat.');
  if (seller !== record.seller) throw new RuleViolation('WRONG_SELLER', 'Penjual berbeda dengan pemilik record.');
  return appendEvent({ ...record, listingRecorded: true });
}

/**
 * `recordReserve`: satu VIN hanya boleh punya SATU deal aktif.
 * Inilah penjagaan on-chain yang tidak ada di program lama (`open_deal` lama
 * memakai seeds [deal, vin_hash, buyer], sehingga dua pembeli bisa membuka dua
 * deal paralel untuk satu VIN).
 */
export function recordReserve(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (!record.listingRecorded) throw new RuleViolation('NOT_LISTED', 'Listing belum tercatat.');
  if (record.reservedByDeal) {
    throw new RuleViolation('ALREADY_RESERVED', `VIN sudah dikunci deal ${record.reservedByDeal}.`);
  }
  return appendEvent({ ...record, reservedByDeal: dealId });
}

export function releaseReserve(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'Deal ini tidak memegang reserve.');
  return appendEvent({ ...record, reservedByDeal: null });
}

export interface InspectionInput {
  dealId: string;
  odometerKm: number;
  reportHash: string;
  at: string;
}

/**
 * `recordInspection`: menulis laporan DAN menghitung anomali dari state
 * on-chain. Server tidak bisa menyembunyikan selisih karena ambangnya di sini.
 */
export function recordInspection(record: VinRegistryRecord, input: InspectionInput): { record: VinRegistryRecord; anomaly: boolean } {
  if (record.reservedByDeal !== input.dealId) {
    throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'Laporan hanya sah untuk deal yang memegang reserve VIN ini.');
  }
  if (input.odometerKm < 0) throw new RuleViolation('INVALID_ODOMETER', 'Kilometer tidak boleh negatif.');

  const baseline = record.maxOdometer;
  const anomaly = baseline !== null && input.odometerKm < baseline;

  let next: VinRegistryRecord = {
    ...record,
    lastOdometer: input.odometerKm,
    // Titik tertinggi tidak pernah turun: laporan rendah tidak boleh mereset dasar.
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
 * Pembeli melihat peringatan. Ini WAJIB sebelum `accept_report`, tetapi tidak
 * menghapus catatan anomali — hanya menandai bahwa pembeli sudah melihatnya.
 */
export function acknowledgeAnomaly(record: VinRegistryRecord, by: "buyer"): VinRegistryRecord {
  if (!record.anomalyPending) throw new RuleViolation('NO_ANOMALY', 'Tidak ada anomali menunggu.');
  if (by !== 'buyer') throw new RuleViolation('WRONG_ACTOR', 'Hanya pembeli yang boleh mengakui peringatan.');
  return appendEvent({ ...record, anomalyPending: false });
}

/** `acceptReport` ditolak selama masih ada anomali yang belum dilihat pembeli. */
export function assertCanAcceptReport(record: VinRegistryRecord): void {
  if (record.anomalyPending) {
    throw new RuleViolation('ANOMALY_PENDING', 'Anomali kilometer belum dilihat pembeli; laporan tidak boleh diterima.');
  }
}

export function recordCompletion(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'Deal tidak memegang reserve.');
  if (record.disputeOpen) throw new RuleViolation('DISPUTE_OPEN', 'Sengketa masih terbuka; penyelesaian menunggu putusan arbiter.');
  if (record.completionRecorded) throw new RuleViolation('COMPLETION_EXISTS', 'Completion sudah tercatat.');
  return appendEvent({ ...record, completionRecorded: true });
}

export function recordDispute(record: VinRegistryRecord, dealId: string): VinRegistryRecord {
  if (record.reservedByDeal !== dealId) throw new RuleViolation('NOT_RESERVED_BY_DEAL', 'Deal tidak memegang reserve.');
  return appendEvent({ ...record, disputeOpen: true });
}

export function recordResolution(record: VinRegistryRecord): VinRegistryRecord {
  if (!record.disputeOpen) throw new RuleViolation('NO_DISPUTE', 'Tidak ada sengketa yang terbuka.');
  return appendEvent({ ...record, disputeOpen: false });
}

/**
 * Empat angka kesehatan koridor dihitung dari registry, bukan dari basis data
 * internal: deal selesai, sengketa, anomali yang belum dijelaskan, dan apakah
 * pelaku kembali. (Metrik koridor penuh dihitung di API dari data ini.)
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
