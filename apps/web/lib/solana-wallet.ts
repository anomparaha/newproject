/**
 * Browser-side Solana wallet glue for Sign-In With Solana.
 *
 * No wallet-adapter dependency: the injected provider API (`connect` /
 * `signMessage`) is small and stable, and a dependency-free implementation is
 * easier to audit than a wrapper. The server verifies the signature; nothing
 * here is trusted.
 *
 * If no extension is present the caller must fall back to the labelled demo
 * binding - never to a fake success.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58 (the encoding Solana uses for keys and signatures). */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
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
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += '1';
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}

export interface InjectedSolanaProvider {
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  signMessage?(
    message: Uint8Array,
    encoding?: string,
  ): Promise<{ signature: Uint8Array } | Uint8Array>;
  publicKey?: { toString(): string } | null;
  isConnected?: boolean;
  disconnect?(): Promise<void>;
}

type PhantomProvider = InjectedSolanaProvider & { isPhantom?: boolean };

declare global {
  interface Window {
    solana?: PhantomProvider;
    phantom?: { solana?: PhantomProvider };
    solflare?: InjectedSolanaProvider & { isSolflare?: boolean };
    backpack?: { solana?: InjectedSolanaProvider };
  }
}

export interface WalletOption {
  id: string;
  name: string;
  detect: () => InjectedSolanaProvider | null;
}

export const WALLET_OPTIONS: WalletOption[] = [
  { id: 'phantom', name: 'Phantom', detect: () => window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null) ?? null },
  { id: 'solflare', name: 'Solflare', detect: () => window.solflare ?? null },
  { id: 'backpack', name: 'Backpack', detect: () => window.backpack?.solana ?? null },
];

export function detectWallet(walletId: string): InjectedSolanaProvider | null {
  if (typeof window === 'undefined') return null;
  const option = WALLET_OPTIONS.find((entry) => entry.id === walletId);
  if (option) return option.detect();
  // Any injected provider is better than none when the user picked "a wallet".
  return window.phantom?.solana ?? window.solflare ?? window.solana ?? window.backpack?.solana ?? null;
}

export class WalletUnavailableError extends Error {}

/**
 * Connect and return the address.
 *
 * Connecting first is required: the challenge names the address, so the server
 * cannot issue it before the provider has told us who the user is.
 */
export async function connectWallet(
  walletId: string,
): Promise<{ provider: InjectedSolanaProvider; address: string }> {
  const provider = detectWallet(walletId);
  if (!provider || typeof provider.signMessage !== 'function') {
    throw new WalletUnavailableError(`No ${walletId} wallet detected in this browser`);
  }

  const connection = await provider.connect();
  const address = connection?.publicKey?.toString?.() ?? provider.publicKey?.toString?.();
  if (!address) throw new WalletUnavailableError('The wallet connected but exposed no public key');

  return { provider, address };
}

/**
 * Sign the exact challenge message.
 *
 * The message is signed as raw UTF-8 bytes: no hashing, no prefixes. That is
 * what the server verifies, so any transformation here would be a bug.
 */
export async function signChallenge(provider: InjectedSolanaProvider, message: string): Promise<string> {
  if (typeof provider.signMessage !== 'function') {
    throw new WalletUnavailableError('This wallet cannot sign messages');
  }
  const result = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
  const signatureBytes = result instanceof Uint8Array ? result : result?.signature;
  if (!signatureBytes) throw new WalletUnavailableError('The wallet returned no signature');
  return base58Encode(signatureBytes);
}
