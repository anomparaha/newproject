/**
 * Sign-In With Solana (SIWS-style).
 *
 * What this really does: the server issues a single-use nonce and a message, the
 * wallet signs the raw message bytes with its ed25519 key, and the server
 * verifies that signature against the public key that IS the wallet address.
 * A verified signature is what proves the caller controls the address.
 *
 * Design notes worth keeping:
 *  - The nonce is SINGLE-USE and expires. Without that, a captured signature is
 *    a permanent login token for whoever has it.
 *  - The exact message string is stored with the nonce and verified against that
 *    stored copy, so a mismatch between the client's rendering and the server's
 *    re-derivation cannot silently accept a different message.
 *  - Session tokens are stored ONLY as a sha256 hash. A database dump must not
 *    hand out working logins.
 *  - Ed25519 verification uses node:crypto with the fixed SPKI prefix, so the
 *    API needs no signing library.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { base58Decode } from './base58.js';
import { get, newId, nowIso, run, type Row } from './db.js';

/** SPKI DER prefix for an Ed25519 public key: the 12 bytes before the raw key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const NONCE_TTL_MINUTES = 5;
export const SESSION_TTL_DAYS = 30;

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 409 = 401,
  ) {
    super(message);
  }
}

/** A Solana address is a base58 string that decodes to exactly 32 bytes. */
export function isValidSolanaAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false;
  try {
    return base58Decode(address).length === 32;
  } catch {
    return false;
  }
}

export function addressBytes(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) throw new AuthError('INVALID_ADDRESS', 'A Solana address must decode to 32 bytes', 400);
  return bytes;
}

function ed25519PublicKey(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

/** Verify a detached ed25519 signature over the UTF-8 bytes of `message`. */
export function verifySignature(message: string, signature: Uint8Array, publicKeyRaw: Uint8Array): boolean {
  if (signature.length !== 64 || publicKeyRaw.length !== 32) return false;
  try {
    return cryptoVerify(null, Buffer.from(message, 'utf8'), ed25519PublicKey(publicKeyRaw), Buffer.from(signature));
  } catch {
    return false;
  }
}

export const SIGN_IN_STATEMENT =
  'Sign in to VIN. This signature proves you control this wallet. It does not move funds, approve a transaction, or cost anything.';

/**
 * The SIWS message. Field order follows the SIWS/SIWE convention so wallets and
 * reviewers recognise it. The statement explains what the signature does NOT do,
 * because users have been trained to fear blind signing.
 */
export function buildMessage(input: {
  domain: string;
  address: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    input.address,
    '',
    SIGN_IN_STATEMENT,
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expiresAt}`,
  ].join('\n');
}

export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: string;
}

export function createChallenge(
  db: DatabaseSync,
  input: { walletAddress: string; domain: string; uri: string; chainId: string; ttlMinutes?: number },
): Challenge {
  if (!isValidSolanaAddress(input.walletAddress)) {
    throw new AuthError('INVALID_ADDRESS', 'walletAddress is not a valid Solana address', 400);
  }

  // Opportunistic cleanup: expired, unused nonces only exist to be forgotten.
  run(db, 'DELETE FROM auth_nonces WHERE expires_at < ? AND used_at IS NULL', [nowIso()]);

  const nonce = randomBytes(16).toString('hex');
  const issuedAt = nowIso();
  const ttl = input.ttlMinutes ?? NONCE_TTL_MINUTES;
  const expiresAt = new Date(Date.parse(issuedAt) + ttl * 60_000).toISOString();
  const message = buildMessage({
    domain: input.domain,
    address: input.walletAddress,
    uri: input.uri,
    chainId: input.chainId,
    nonce,
    issuedAt,
    expiresAt,
  });

  run(
    db,
    `INSERT INTO auth_nonces (nonce, wallet_address, message, domain, issued_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [nonce, input.walletAddress, message, input.domain, issuedAt, expiresAt],
  );

  return { nonce, message, expiresAt };
}

export function nonceRow(db: DatabaseSync, nonce: string): Row | undefined {
  return get(db, 'SELECT * FROM auth_nonces WHERE nonce = ?', [nonce]);
}

/**
 * Verify a signed challenge and burn the nonce.
 *
 * Order matters: the nonce is only marked used AFTER the signature verifies, so
 * a failed attempt cannot destroy a legitimate challenge in flight.
 */
export function verifyChallenge(
  db: DatabaseSync,
  input: { walletAddress: string; nonce: string; signature: string },
): { nonce: string; walletAddress: string } {
  const row = nonceRow(db, input.nonce);
  if (!row) throw new AuthError('CHALLENGE_NOT_FOUND', 'Unknown challenge; request a new one', 400);
  if (row.used_at !== null) throw new AuthError('CHALLENGE_USED', 'This challenge was already used', 409);
  if (Date.parse(String(row.expires_at)) < Date.now()) {
    throw new AuthError('CHALLENGE_EXPIRED', 'This challenge expired; request a new one', 409);
  }
  if (String(row.wallet_address) !== input.walletAddress) {
    throw new AuthError('ADDRESS_MISMATCH', 'The challenge was issued for a different wallet', 401);
  }

  const signatureBytes = (() => {
    try {
      return base58Decode(input.signature);
    } catch {
      return null;
    }
  })();
  if (!signatureBytes) throw new AuthError('BAD_SIGNATURE', 'signature is not valid base58', 401);

  const ok = verifySignature(String(row.message), signatureBytes, addressBytes(input.walletAddress));
  if (!ok) throw new AuthError('BAD_SIGNATURE', 'The signature does not match the challenge', 401);

  const burned = db
    .prepare('UPDATE auth_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL')
    .run(nowIso(), input.nonce) as { changes?: number };
  if (!burned.changes) throw new AuthError('CHALLENGE_USED', 'This challenge was already used', 409);

  return { nonce: input.nonce, walletAddress: input.walletAddress };
}

export function findActorByWallet(db: DatabaseSync, walletAddress: string): Row | undefined {
  return get(db, 'SELECT * FROM actors WHERE wallet_address = ?', [walletAddress]);
}

/**
 * Create the account for a wallet that has never signed in.
 *
 * Buyers are self-serve. Sellers, workshops and curators carry business identity,
 * so their account is created with `verification = 'none'` and stays that way
 * until a KYB attestation exists (not built).
 */
export function createWalletActor(
  db: DatabaseSync,
  input: {
    walletAddress: string;
    role: 'buyer' | 'seller' | 'inspector' | 'curator' | 'arbiter';
    displayName: string;
    email: string;
    countryCode: string;
    city?: string;
  },
): Row {
  const id = newId(input.role === 'inspector' ? 'insp' : 'act');
  const createdAt = nowIso();
  const verification = input.role === 'buyer' ? 'basic' : 'none';
  run(
    db,
    `INSERT INTO actors (id, role, display_name, email, wallet_address, payout_address, verification, country_code, city, base_currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USDC', ?)`,
    [
      id,
      input.role,
      input.displayName,
      input.email,
      input.walletAddress,
      input.walletAddress,
      verification,
      input.countryCode.toUpperCase(),
      input.city ?? null,
      createdAt,
    ],
  );
  run(db, 'INSERT INTO reputation (actor_id, role, last_computed_at) VALUES (?, ?, ?)', [id, input.role, createdAt]);
  return get(db, 'SELECT * FROM actors WHERE id = ?', [id])!;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  token: string;
  expiresAt: string;
}

export function issueSession(
  db: DatabaseSync,
  input: { actorId: string; method: string; walletAddress?: string; ttlDays?: number },
): IssuedSession {
  const token = randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.parse(createdAt) + (input.ttlDays ?? SESSION_TTL_DAYS) * 86_400_000).toISOString();
  run(
    db,
    `INSERT INTO sessions (id, actor_id, token_hash, method, wallet_address, created_at, expires_at, revoked_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    [newId('sess'), input.actorId, hashToken(token), input.method, input.walletAddress ?? null, createdAt, expiresAt],
  );
  return { token, expiresAt };
}

/** Resolve a bearer token to an actor. Returns null for unknown/expired/revoked tokens. */
export function actorIdForToken(db: DatabaseSync, token: string): string | null {
  const row = get(db, 'SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (Date.parse(String(row.expires_at)) < Date.now()) return null;
  run(db, 'UPDATE sessions SET last_used_at = ? WHERE id = ?', [nowIso(), String(row.id)]);
  return String(row.actor_id);
}

export function sessionRowForToken(db: DatabaseSync, token: string): Row | undefined {
  return get(db, 'SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

export function revokeSession(db: DatabaseSync, token: string): boolean {
  const changed = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(nowIso(), hashToken(token)) as { changes?: number };
  return Boolean(changed.changes);
}
