/**
 * Kebijakan platform VIN.
 *
 * Angka di sini adalah KEPUTUSAN PRODUK yang harus dibaca sebagai parameter
 * operasional, bukan janji investasi. Semua ambang dapat diubah lewat tata
 * kelola platform dan wajib dicatat sebagai event bila mengubah aturan koridor.
 */

import type { Corridor, CorridorMetrics, TokenUtility } from '@vin/shared';
import { TOKEN_UTILITY } from '@vin/shared';

// ---------------------------------------------------------------------------
// Fee
// ---------------------------------------------------------------------------

export const FEES = {
  /** Fee transaksi kendaraan. */
  vehicleBps: 100, // 1.00%
  /** Fee aplikasi inspeksi. */
  inspectionBps: 500, // 5.00% dari biaya inspeksi
  /** Potongan fee bila dibayar dengan token platform (diskon). */
  tokenDiscountFactor: 0.6,
  /** Bakar token hanya dari fee yang benar-benar terkumpul dari pemakaian. */
  burnFromCollectedFeesOnly: true,
} as const;

// ---------------------------------------------------------------------------
// Jaminan
// ---------------------------------------------------------------------------

export const BONDS = {
  /** Jaminan listing di atas ambang nilai koridor. */
  listingBondUsdc: '50',
  /** Jaminan bengkel untuk menerima order. */
  inspectorBondUsdc: '25',
  /** Batas nilai di bawah mana jaminan boleh dalam stablecoin dulu (Tahap Bukti). */
  stablecoinAllowedBelowUsd: 30_000,
  /** Potongan jaminan saat pelanggaran. Separuh masuk kas sengketa, bukan tim. */
  slashRatio: 0.5,
  disputeFundShare: 1.0,
} as const;

// ---------------------------------------------------------------------------
// Koridor
// ---------------------------------------------------------------------------

export const PILOT_CORRIDOR: Omit<Corridor, 'openedAt'> & { openedAt: string } = {
  id: 'cor_id_sg',
  originCountry: 'ID',
  destinationCountry: 'SG',
  minVehiclePriceUsd: 15_000,
  mandatoryInspection: true,
  allowedCurrencies: ['USDC', 'IDR'],
  status: 'pilot',
  openedAt: '2026-01-15T00:00:00.000Z',
};

/** Koridor kandidat: belum boleh dilayani sampai koridor pilot sehat. */
export const CANDIDATE_CORRIDORS = [
  { originCountry: 'ID', destinationCountry: 'MY', reason: 'Menunggu koridor pilot stabil' },
  { originCountry: 'JP', destinationCountry: 'ID', reason: 'JIS/ekspor Jepang: butuh bengkel terverifikasi di Jepang' },
] as const;

// ---------------------------------------------------------------------------
// Kapasitas (akses token, bukan pembelian)
// ---------------------------------------------------------------------------

export const CAPACITY = {
  /** Batas listing aktif untuk dealer tanpa stake kapasitas. */
  freeActiveListingsPerSeller: 3,
  /** Tambahan slot listing per stake kapasitas, bukan pembelian slot. */
  listingsPer1000Tokens: 5,
  /** Antrean inspeksi: bengkel dengan stake kapasitas tampil pada antrean utama. */
  priorityQueue: true,
} as const;

export const TOKEN: TokenUtility = TOKEN_UTILITY;

// ---------------------------------------------------------------------------
// Pemicu berhenti perluasan (playbook §10)
// ---------------------------------------------------------------------------

export const HALT_THRESHOLDS = {
  minDealsCompleted: 2,
  maxDisputeRate: 0.15,
  maxUnexplainedAnomalies: 3,
  minSellerReturnRate: 0.3,
  minInspectorReturnRate: 0.3,
} as const;

/**
 * Keempat angka buruk SEKALIGUS -> perluasan dihentikan. Menambah utilitas token
 * tidak memperbaiki pasar yang belum menyelesaikan kendaraan fisik.
 */
export function evaluateCorridorHealth(metrics: CorridorMetrics): { halted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (metrics.dealsCompleted < HALT_THRESHOLDS.minDealsCompleted) reasons.push('deal_selesai_rendah');
  if (metrics.disputeRate > HALT_THRESHOLDS.maxDisputeRate) reasons.push('sengketa_tinggi');
  if (metrics.unexplainedOdometerAnomalies > HALT_THRESHOLDS.maxUnexplainedAnomalies) {
    reasons.push('anomali_kilometer_belum_dijelaskan');
  }
  if (
    metrics.sellerReturnRate < HALT_THRESHOLDS.minSellerReturnRate ||
    metrics.inspectorReturnRate < HALT_THRESHOLDS.minInspectorReturnRate
  ) {
    reasons.push('penjual_atau_bengkel_tidak_kembali');
  }
  const halted = reasons.length >= 4;
  return { halted, reasons: halted ? reasons : [] };
}

// ---------------------------------------------------------------------------
// Tahapan publikasi (playbook §9)
// ---------------------------------------------------------------------------

export const PUBLICATION_STAGES = [
  {
    id: 'bukti',
    label: 'Tahap Bukti',
    allowed: [
      'satu_koridor',
      'inspeksi_wajib',
      'escrow_wajib',
      'riwayat_vin_menyala',
      'nft_nota_untuk_deal_selesai',
      'jaminan_stablecoin',
    ],
    forbidden: ['penjualan_token_ke_publik', 'proyeksi_harga_token'],
  },
  {
    id: 'pasar',
    label: 'Tahap Pasar',
    allowed: [
      'bengkel_pihak_ketiga',
      'standar_laporan',
      'pembekuan_sengketa',
      'metrik_publik: deal_selesai, median_waktu_laporan, tingkat_sengketa',
    ],
    forbidden: ['proyeksi_harga_token'],
  },
  {
    id: 'token',
    label: 'Tahap Token',
    allowed: [
      'jaminan_token',
      'potongan_fee_token',
      'akses_kapasitas',
      'distribusi: operasional, likuiditas_terbatas, program_pemakai',
    ],
    forbidden: ['alokasi_hak_atas_pendapatan', 'janji_hasil_untuk_holder'],
  },
  {
    id: 'perluasan',
    label: 'Tahap Perluasan',
    allowed: ['koridor_kedua', 'bengkel_lokal_terverifikasi', 'riwayat_vin_lama_tetap_terbaca'],
    forbidden: ['mengubah_aturan_anomali_kilometer_mundur'],
  },
] as const;

export const PUBLIC_METRICS = ['deals_completed', 'median_hours_to_report', 'dispute_rate'] as const;

/** Metrik token yang sah dibicarakan. Volume perdagangan BUKAN bukti ekosistem hidup. */
export const TOKEN_METRICS_NOTE =
  'Metrik yang relevan hanya nilai jaminan yang terkunci oleh penjual dan bengkel aktif, ' +
  'fee yang dibayar dengan token, dan jumlah deal selesai. Volume perdagangan token di luar itu ' +
  'tidak membuktikan ekosistem hidup.';

export const DISCLAIMERS = {
  nftNotTitle:
    'NFT pada VIN adalah nota dan jejak klaim, bukan surat kendaraan. BPKB, title, registrasi, ' +
    'bea cukai, pajak, dan balik nama mengikuti hukum negara asal dan negara tujuan.',
  tokenNotEquity:
    'Token VIN bukan saham platform, bukan alat bayar harga mobil, tidak memberi bagi hasil, ' +
    'dan tidak memberi hak suara atas pendapatan perusahaan.',
  reportNotWarranty:
    'Laporan inspeksi adalah temuan pada tanggal inspeksi, bukan garansi sampai kendaraan tiba ' +
    'di negara pembeli.',
  moneyRule:
    'Harga kendaraan, ongkir, dan biaya inspeksi dibayar dengan stablecoin atau fiat. ' +
    'Penjual dan bengkel menerima stablecoin atau fiat, dan tidak dipaksa memegang token.',
} as const;
