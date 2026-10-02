/**
 * Uang: jumlah sebagai string desimal (tidak pernah float), fee, dan
 * peluruhan jaminan. Semua perhitungan memakai BigInt dengan skala 6 desimal
 * (USDC) atau skala 0 (IDR).
 */

export class MoneyError extends Error {}

const DECIMALS: Record<string, number> = { USDC: 6, USD: 2, IDR: 0 };

export function decimalsFor(currency: string): number {
  const d = DECIMALS[currency.toUpperCase()];
  if (d === undefined) throw new MoneyError(`Mata uang tidak didukung: ${currency}`);
  return d;
}

/** "1234.5" + USDC -> 1234500000n */
export function toMinorUnits(amount: string, currency: string): bigint {
  const d = decimalsFor(currency);
  const trimmed = amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new MoneyError(`Jumlah tidak valid: ${amount}`);
  const negative = trimmed.startsWith('-');
  const abs = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', frac = ''] = abs.split('.');
  if (frac.length > d) {
    throw new MoneyError(`${currency} hanya mendukung ${d} angka desimal`);
  }
  const padded = frac.padEnd(d, '0');
  const value = BigInt(whole) * 10n ** BigInt(d) + BigInt(padded === '' ? '0' : padded);
  return negative ? -value : value;
}

export function fromMinorUnits(value: bigint, currency: string): string {
  const d = decimalsFor(currency);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(d);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = d === 0 ? '' : `.${frac.toString().padStart(d, '0')}`;
  return `${negative ? '-' : ''}${whole}${fracStr}`;
}

export function addAmount(a: string, b: string, currency: string): string {
  return fromMinorUnits(toMinorUnits(a, currency) + toMinorUnits(b, currency), currency);
}

/** Fee platform proporsional, dibulatkan ke bawah (tidak pernah lebih dari seharusnya). */
export function bpsFee(amount: string, bps: number, currency: string): string {
  if (bps < 0 || bps > 10_000) throw new MoneyError('bps harus 0..10000');
  const minor = toMinorUnits(amount, currency);
  return fromMinorUnits((minor * BigInt(bps)) / 10_000n, currency);
}

/** Diskon fee bila dibayar dengan token platform. Yang tidak punya token tetap bisa bayar dengan stablecoin. */
export function feeWithTokenDiscount(amount: string, bps: number, currency: string, payWithToken: boolean): string {
  const effective = payWithToken ? Math.floor(bps * 0.6) : bps;
  return bpsFee(amount, effective, currency);
}

export function compareAmounts(a: string, b: string, currency: string): -1 | 0 | 1 {
  const x = toMinorUnits(a, currency);
  const y = toMinorUnits(b, currency);
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Peluruhan jaminan: sebagian potongan masuk KAS SENGKETA, bukan ke dompet tim.
 * Ini hanya perhitungan; pemindahan dana tetap dijalankan escrow provider.
 */
export interface SlashBreakdown {
  slashed: string;
  toDisputeFund: string;
  toBuyerCompensation: string;
  returnedToActor: string;
}

export function slashBond(bond: string, currency: string, slashedRatio = 0.5, compensationRatio = 0.5): SlashBreakdown {
  if (slashedRatio < 0 || slashedRatio > 1) throw new MoneyError('slashedRatio 0..1');
  if (compensationRatio < 0 || compensationRatio > 1) throw new MoneyError('compensationRatio 0..1');
  const bondMinor = toMinorUnits(bond, currency);
  const slashedMinor = (bondMinor * BigInt(Math.round(slashedRatio * 10_000))) / 10_000n;
  const compensationMinor = (slashedMinor * BigInt(Math.round(compensationRatio * 10_000))) / 10_000n;
  return {
    slashed: fromMinorUnits(slashedMinor, currency),
    toDisputeFund: fromMinorUnits(slashedMinor - compensationMinor, currency),
    toBuyerCompensation: fromMinorUnits(compensationMinor, currency),
    returnedToActor: fromMinorUnits(bondMinor - slashedMinor, currency),
  };
}
