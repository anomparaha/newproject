/**
 * Skema validasi & hash kriptografis.
 *
 * Prinsip: file mentah disimpan off-chain; yang dikunci hanyalah hash.
 * `anchorPayload` menormalkan payload menjadi JSON kanonik sehingga hash
 * dapat diverifikasi ulang oleh pihak ketiga dari data mentah.
 */

import { z } from 'zod';

export const zBase58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Alamat Solana base58 tidak valid');
export const zSha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'Hash harus sha256 hex 64 karakter');
export const zCurrency = z.enum(['USDC', 'IDR', 'USD']);
export const zAmount = z.string().regex(/^\d+(\.\d+)?$/, 'Jumlah harus string desimal positif');
export const zCountryCode = z.string().length(2).transform((v) => v.toUpperCase());

export const zRegisterActor = z.object({
  role: z.enum(['buyer', 'seller', 'inspector', 'curator', 'arbiter']),
  displayName: z.string().min(2).max(120),
  email: z.string().email(),
  countryCode: zCountryCode,
  city: z.string().max(80).optional(),
  walletAddress: zBase58.optional(),
  payoutAddress: zBase58.optional(),
});

export const zCreateListing = z.object({
  vin: z.string().min(6).max(24).transform((v) => v.toUpperCase()),
  sellerId: z.string().min(1),
  make: z.string().min(1).max(60),
  model: z.string().min(1).max(60),
  year: z.number().int().min(1950).max(2100),
  odometerKm: z.number().int().min(0).optional(),
  location: z.string().min(2).max(160),
  priceAmount: zAmount,
  priceCurrency: zCurrency,
  shippingTerms: z.string().min(4).max(400),
  photoHashes: z.array(zSha256Hex).min(1).max(40),
  /** Bobot jaminan bila listing tayang di atas ambang nilai koridor. */
  bond: z
    .object({ amount: zAmount, currency: z.enum(['VIN', 'USDC']) })
    .optional(),
});

export const zCommitDeal = z.object({
  buyerId: z.string().min(1),
  inspectorId: z.string().min(1),
  shippingPaidBy: z.enum(['buyer', 'seller']),
  shippingAmount: zAmount,
  inspectionFeeAmount: zAmount,
  escrowCurrency: z.enum(['USDC', 'IDR']).default('USDC'),
  inspectionDeadlineHours: z.number().int().min(6).max(720).default(72),
  handoverTerms: z.string().min(4).max(400),
});

export const zUploadReport = z.object({
  inspectorId: z.string().min(1),
  odometerKm: z.number().int().min(0),
  inspectedAt: z.string().datetime(),
  reportHash: zSha256Hex,
  dashboardPhotoHash: zSha256Hex,
  conditionSummary: z.string().min(4).max(2000),
  standardVersion: z.string().min(1).max(32),
  /** Item minimum yang diperiksa - bila kurang, laporan dianggap tidak memenuhi standar. */
  checklist: z
    .object({
      vin_matches_unit: z.boolean(),
      dashboard_photo: z.boolean(),
      odometer_documented: z.boolean(),
      main_condition: z.boolean(),
      date_and_location: z.boolean(),
    })
    .required({}),
});

export const zOpenDispute = z.object({
  openedBy: z.string().min(1),
  reason: z.string().min(10).max(2000),
});

export const zResolveDispute = z.object({
  arbiterId: z.string().min(1),
  outcome: z.enum(['refund_buyer', 'release_to_seller', 'split', 'bond_slashed']),
  refundedAmount: zAmount.optional(),
  releasedAmount: zAmount.optional(),
  bondSlashedAmount: zAmount.optional(),
  arbiterNote: z.string().min(4).max(2000),
});

export const zCreateCorridor = z.object({
  originCountry: zCountryCode,
  destinationCountry: zCountryCode,
  minVehiclePriceUsd: z.number().positive(),
  allowedCurrencies: z.array(zCurrency).min(1),
});

export const zConfirmHandover = z.object({
  actorId: z.string().min(1),
  evidenceHash: zSha256Hex.optional(),
  method: z.enum(['handover_location_confirmed', 'load_proof', 'mutual_confirmation']),
});

/** Laporan minimum sesuai konsep §3 & §4. */
export const REQUIRED_REPORT_ITEMS = [
  'vin_matches_unit',
  'dashboard_photo',
  'odometer_documented',
  'main_condition',
  'date_and_location',
] as const;

export function reportMeetsStandard(checklist: Record<string, boolean>): { ok: boolean; missing: string[] } {
  const missing = REQUIRED_REPORT_ITEMS.filter((k) => checklist[k] !== true);
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Hashing (sha256, Web Crypto - jalan di Node 22, edge, dan browser)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes: Uint8Array = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // Buffer yang sudah pasti (bukan SharedArrayBuffer) supaya tipe ini jalan
  // di Node, Edge Runtime, maupun browser tanpa bergantung pada lib DOM.
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

/** JSON kanonik: urutan kunci deterministik supaya hash dapat direproduksi. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Payload yang ditulis ke Solana: VIN, hash, status, dan waktu.
 * Data pribadi pembeli/penjual TIDAK ditulis ke chain.
 */
export interface AnchorPayloadInput {
  vin: string;
  eventType: string;
  eventHash: string;
  occurredAt: string;
  dealRef: string;
}

export async function anchorPayloadHash(input: AnchorPayloadInput): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

/** Merkle root sederhana untuk hash seluruh bukti satu nota. */
export async function evidenceRoot(hashes: string[]): Promise<string> {
  if (hashes.length === 0) return sha256Hex('');
  let level = hashes.slice().sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(await sha256Hex(left + right));
    }
    level = next;
  }
  return level[0]!;
}

export const schemas = {
  zRegisterActor,
  zCreateListing,
  zCommitDeal,
  zUploadReport,
  zOpenDispute,
  zResolveDispute,
  zCreateCorridor,
  zConfirmHandover,
};
