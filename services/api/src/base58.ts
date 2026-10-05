/**
 * Minimal base58 codec (Bitcoin/Solana alphabet).
 *
 * The API deliberately keeps its dependency list small, and shipping a
 * well-tested 40-line codec is smaller than adding a package for it. Solana
 * public keys and signatures are base58 strings; the codec has no other job.
 *
 * Vectors are pinned in services/api/tests/siws.test.ts so a wrong byte order
 * (the classic base58 bug) cannot ship silently.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

export class Base58Error extends Error {}

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);

  // Leading '1' characters are leading zero BYTES. They must be counted before
  // the numeric part is converted, otherwise the positional algorithm emits its
  // own zero placeholder and every all-'1' address gains a phantom byte
  // (32 '1's decoded to 33 bytes until the pinned vector test caught it).
  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === '1') leadingZeros += 1;

  const bytes: number[] = [];
  for (let index = leadingZeros; index < input.length; index += 1) {
    const char = input[index]!;
    const value = INDEX.get(char);
    if (value === undefined) throw new Base58Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  while (digits.length > 0 && digits[digits.length - 1] === 0) digits.pop();

  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += '1';
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
