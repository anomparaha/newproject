/**
 * @vin/shared - tipe domain VIN
 *
 * Aturan inti yang dipakai seluruh sistem (API, web, worker):
 *  1. Satu VIN memiliki RANGKAIAN EVENT. Event lama tidak pernah ditimpa.
 *  2. Uang kendaraan tidak pernah berupa token volatil. Hanya stablecoin / fiat.
 *  3. NFT hanya NOTA dan JEJAK KLAIM. NFT bukan surat kendaraan (bukan BPKB/title).
 *  4. Token platform hanya untuk JAMINAN dan AKSES. Token tidak membeli harga mobil,
 *     tidak memberi bagi hasil, dan tidak memberi hak suara atas pendapatan.
 */

// ---------------------------------------------------------------------------
// Aktor & peran
// ---------------------------------------------------------------------------

export const ROLES = ['buyer', 'seller', 'inspector', 'curator', 'arbiter'] as const;
export type Role = (typeof ROLES)[number];

export const VERIFICATION_LEVELS = ['none', 'basic', 'business_verified', 'suspended'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Satu akun = satu peran (konsep §3 "Pembukaan akun memisahkan peran"). */
export interface Actor {
  id: string;
  role: Role;
  displayName: string;
  email: string;
  /** Dompet Solana (base58) - alamat PENERIMA pembayaran, bukan akun bursa. */
  walletAddress: string | null;
  /**
   * Alamat PENERIMA pembayaran (payout destination). Selalu dibayar dalam
   * stablecoin/fiat. Menyimpan token tidak pernah menjadi syarat dibayar.
   */
  payoutAddress: string | null;
  verification: VerificationLevel;
  /** Untuk inspector: area jangkauan & lokasi basis. */
  countryCode: string;
  city: string | null;
  baseCurrency: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// VIN
// ---------------------------------------------------------------------------

/**
 * VIN di platform !== VIN registrasi resmi.
 * Dua negara bisa memakai format rangka berbeda; keunikan di platform tidak
 * sama dengan keunikan di registrasi resmi. Karena itu setiap halaman
 * kendaraan wajib menampilkan peringatan ini (lihat `vinScopeNotice()`).
 */
export interface VinRecord {
  vin: string;
  make: string;
  model: string;
  year: number;
  originCountry: string;
  platformUnique: true;
}

export function vinScopeNotice(): string {
  return (
    'VIN di VIN hanya unik di dalam platform. Format rangka berbeda antar negara, ' +
    'dan keunikan on-chain tidak sama dengan keunikan registrasi resmi. ' +
    'Catatan ini adalah jejak klaim dan transaksi, bukan title/BPKB.'
  );
}

// ---------------------------------------------------------------------------
// Event - sumber kebenaran
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'listing_created',
  'listing_updated',
  'deal_committed',
  'report_uploaded',
  'odometer_anomaly',
  'inspeksi_dana_lepas',
  'kendaraan_dana_lepas',
  'note_completed',
  'dispute_opened',
  'dispute_resolved',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Status yang bisa dipakai untuk memfilter feed, bukan pengganti event. */
export const EVENT_CATEGORIES = ['kesepakatan', 'inspeksi', 'dana', 'nota', 'sengketa'] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_META: Record<EventType, { label: string; category: EventCategory }> = {
  listing_created: { label: 'Listing dibuat', category: 'kesepakatan' },
  listing_updated: { label: 'Listing diubah sebelum ada pembeli', category: 'kesepakatan' },
  deal_committed: { label: 'Deal dikunci (dana masuk escrow)', category: 'kesepakatan' },
  report_uploaded: { label: 'Laporan inspeksi diunggah', category: 'inspeksi' },
  odometer_anomaly: { label: 'Anomali kilometer', category: 'inspeksi' },
  inspeksi_dana_lepas: { label: 'Dana inspeksi lepas ke bengkel', category: 'dana' },
  kendaraan_dana_lepas: { label: 'Dana kendaraan lepas ke penjual', category: 'dana' },
  note_completed: { label: 'Nota selesai tercatat', category: 'nota' },
  dispute_opened: { label: 'Sengketa dibuka', category: 'sengketa' },
  dispute_resolved: { label: 'Sengketa diputus', category: 'sengketa' },
};

/**
 * Keunikan yang dikunci di on-chain: hanya HASH. File mentah (foto, PDF laporan)
 * disimpan off-chain.
 */
export interface EventPayload {
  // listing
  make?: string;
  model?: string;
  year?: number;
  priceAmount?: string;
  /** Kode mata uang bebas (USDC, IDR, USD, ...). Uang kendaraan selalu stablecoin atau fiat. */
  priceCurrency?: string;
  shippingTerms?: string;
  photoHashes?: string[];
  // deal
  dealId?: string;
  buyerId?: string;
  selectedInspectorId?: string;
  inspectionFeeAmount?: string;
  inspectionFeeCurrency?: string;
  inspectionDeadline?: string;
  escrowRef?: string;
  // inspeksi
  odometerKm?: number;
  inspectedAt?: string;
  inspectorId?: string;
  reportHash?: string;
  dashboardPhotoHash?: string;
  reportStandardVersion?: string;
  anomaly?: {
    previousOdometerKm: number;
    previousEventId: string;
    deltaKm: number;
  };
  // dana
  amount?: string;
  currency?: string;
  platformFeeAmount?: string;
  recipientId?: string;
  payoutRef?: string;
  // nota
  /** Null selama NFT nota belum benar-benar dicetak. Tidak ada klaim sebelum ada aset. */
  noteAssetId?: string | null;
  noteMintAddress?: string | null;
  noteMetadataUri?: string;
  evidenceRoot?: string;
  escrowTxId?: string;
  // sengketa
  disputeId?: string;
  reason?: string;
  outcome?: DisputeOutcome;
  bondSlashedAmount?: string;
  refundedAmount?: string;
  releasedAmount?: string;
  arbiterNote?: string;
}

export const DISPUTE_OUTCOMES = [
  'refund_buyer',
  'release_to_seller',
  'split',
  'bond_slashed',
] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export interface VinEvent {
  id: string;
  vin: string;
  seq: number;
  type: EventType;
  category: EventCategory;
  /** JOIN ke deal untuk memisahkan rangkaian event per transaksi. */
  dealId: string | null;
  payload: EventPayload;
  /** Alamat Solana tempat hash anchor ditulis (opsional, setelah tahap publikasi). */
  anchorSignature: string | null;
  /** Siapa yang memicu. Selalu aktor, tidak pernah "sistem" tanpa jejak. */
  actorId: string | null;
  actorRole: Role | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Listing & deal
// ---------------------------------------------------------------------------

export const LISTING_STATUSES = ['draft', 'listed', 'reserved', 'completed', 'cancelled', 'disputed'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const DEAL_STATES = [
  'draft',
  'escrow_pending',
  'inspecting',
  'inspection_accepted',
  'handover_pending',
  'completed',
  'frozen',
  'cancelled',
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export interface Listing {
  id: string;
  vin: string;
  sellerId: string;
  make: string;
  model: string;
  year: number;
  odometerKm: number | null;
  location: string;
  priceAmount: string;
  priceCurrency: 'USDC' | 'IDR' | 'USD';
  shippingTerms: string;
  photoHashes: string[];
  status: ListingStatus;
  bondAmount: string;
  bondCurrency: 'VIN' | 'USDC';
  createdAt: string;
  updatedAt: string;
}

export interface InspectionReport {
  id: string;
  dealId: string;
  vin: string;
  inspectorId: string;
  odometerKm: number;
  inspectedAt: string;
  /** File mentah off-chain; yang dikunci hanya hash. */
  reportHash: string;
  dashboardPhotoHash: string;
  conditionSummary: string;
  standardVersion: string;
  anomaly: boolean;
}

export interface Deal {
  id: string;
  listingId: string;
  vin: string;
  buyerId: string;
  sellerId: string;
  inspectorId: string;
  state: DealState;
  priceAmount: string;
  priceCurrency: string;
  shippingPaidBy: 'buyer' | 'seller';
  shippingAmount: string;
  inspectionFeeAmount: string;
  /** Escrow kendaraan dan escrow inspeksi dipisah. */
  escrowRefVehicle: string | null;
  escrowRefInspection: string | null;
  /** Dana inspeksi cair hanya setelah laporan lengkap & diterima pembeli. */
  inspectionReleasedAt: string | null;
  /** Dana kendaraan cair hanya setelah syarat serah terima terpenuhi. */
  vehicleReleasedAt: string | null;
  inspectionDeadline: string;
  handoverTerms: string;
  handoverConfirmedBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Dispute {
  id: string;
  dealId: string;
  openedBy: string;
  reason: string;
  state: 'open' | 'resolved';
  outcome: DisputeOutcome | null;
  arbiterId: string | null;
  bondSlashedAmount: string | null;
  refundedAmount: string | null;
  releasedAmount: string | null;
  arbiterNote: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface Bond {
  id: string;
  actorId: string;
  purpose: 'listing' | 'inspection_capacity';
  amount: string;
  currency: 'VIN' | 'USDC';
  state: 'locked' | 'returned' | 'slashed';
  listingId: string | null;
  lockedAt: string;
  settledAt: string | null;
  reason: string | null;
}

export interface ReputationSnapshot {
  actorId: string;
  role: Role;
  dealsCompleted: number;
  disputesOpened: number;
  disputesLost: number;
  onTimeReportRate: number | null;
  standardComplianceRate: number | null;
  medianReportHours: number | null;
  listedInRanking: boolean;
  lastComputedAt: string;
}

// ---------------------------------------------------------------------------
// Escrow (abstraksi penyedia - DP / kustodian saat MVP, Anchor saat skala)
// ---------------------------------------------------------------------------

export const ESCROW_LEGS = ['vehicle', 'inspection'] as const;
export type EscrowLeg = (typeof ESCROW_LEGS)[number];

export type EscrowProviderKind = 'mock' | 'anchor_solana' | 'licensed_custodian';

export const ESCROW_STATUSES = [
  'pending',
  'funded',
  'frozen',
  'released',
  'refunded',
  'partially_released',
  'slashed',
] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];

export interface ReleaseTerms {
  vehicle: ('handover_location_confirmed' | 'load_proof' | 'mutual_confirmation')[];
  inspection: ('report_uploaded' | 'buyer_accepted' | 'deadline_elapsed')[];
}

export interface Escrow {
  id: string;
  dealId: string;
  leg: EscrowLeg;
  provider: EscrowProviderKind;
  amount: string;
  currency: string;
  status: EscrowStatus;
  releaseTerms: ReleaseTerms;
  fundedAt: string | null;
  releasedAt: string | null;
  txRef: string | null;
}

// ---------------------------------------------------------------------------
// Token: jaminan & akses. Tidak ada fungsi lain.
// ---------------------------------------------------------------------------

export interface TokenUtility {
  /** Tiga fungsi token - dan hanya tiga ini. */
  functions: readonly ['jaminan_listing', 'potongan_fee', 'akses_kapasitas'];
  neverDoes: readonly [
    'membeli_harga_kendaraan',
    'bagi_hasil_pendapatan',
    'hak_suara_atas_perusahaan',
  ];
}

export const TOKEN_UTILITY: TokenUtility = {
  functions: ['jaminan_listing', 'potongan_fee', 'akses_kapasitas'],
  neverDoes: ['membeli_harga_kendaraan', 'bagi_hasil_pendapatan', 'hak_suara_atas_perusahaan'],
};

// ---------------------------------------------------------------------------
// Koridor (koridor pertama sengaja sempit)
// ---------------------------------------------------------------------------

export interface Corridor {
  id: string;
  originCountry: string;
  destinationCountry: string;
  minVehiclePriceUsd: number;
  mandatoryInspection: true;
  allowedCurrencies: string[];
  status: 'pilot' | 'active' | 'paused';
  openedAt: string;
}

export interface CorridorMetrics {
  corridorId: string;
  dealsCompleted: number;
  disputeRate: number;
  medianHoursToReport: number | null;
  unexplainedOdometerAnomalies: number;
  sellerReturnRate: number;
  inspectorReturnRate: number;
  /** Pemicu berhenti perluasan (playbook §10). */
  expansionHalted: boolean;
  haltReasons: string[];
}

// ---------------------------------------------------------------------------
// API DTO
// ---------------------------------------------------------------------------

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  INSPECTOR_CONFLICT: 'INSPECTOR_CONFLICT',
  BOND_REQUIRED: 'BOND_REQUIRED',
  LISTING_ALREADY_RESERVED: 'LISTING_ALREADY_RESERVED',
  DEADLINE_PASSED: 'DEADLINE_PASSED',
  DEAL_FROZEN: 'DEAL_FROZEN',
  CORRIDOR_NOT_SERVED: 'CORRIDOR_NOT_SERVED',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
