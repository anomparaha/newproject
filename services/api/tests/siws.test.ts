/**
 * SIWS (Sign-In With Solana) tests.
 *
 * These are not shape tests. They generate a real ed25519 keypair, sign the
 * exact challenge message the server produced, and prove that:
 *
 *   1. the base58 codec matches the standard (pinned external vectors, because
 *      every other test round-trips through the same codec and would pass even
 *      if both encode and decode were wrong in the same way),
 *   2. a valid signature creates a session,
 *   3. a tampered message, tampered signature, or different key does NOT,
 *   4. a nonce is single-use (replay is refused),
 *   5. an expired nonce is refused,
 *   6. a session token grants identity-based write access, and
 *   7. with VIN_DEMO_MODE=false the x-actor-id header stops working entirely.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { base58Decode, base58Encode } from '../src/base58.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

/** A throwaway ed25519 identity: the public key IS the wallet address. */
function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const address = base58Encode(new Uint8Array(raw));
  return {
    address,
    sign(message: string): string {
      return base58Encode(new Uint8Array(cryptoSign(null, Buffer.from(message, 'utf8'), privateKey)));
    },
  };
}

type Challenge = { nonce: string; message: string; expiresAt: string; knownWallet: boolean };

async function requestChallenge(app: ReturnType<typeof createApp>, walletAddress: string): Promise<Challenge> {
  const res = await app.request('/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress }),
  });
  assert.equal(res.status, 200, `challenge failed: ${res.status}`);
  return (await res.json()) as Challenge;
}

async function verify(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, any> }> {
  const res = await app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

test('base58: leading zeros and standard vectors survive the codec', () => {
  // The Solana System Program address is 32 zero bytes.
  assert.equal(base58Decode('11111111111111111111111111111111').length, 32);
  assert.ok(base58Decode('11111111111111111111111111111111').every((byte) => byte === 0));

  // Pinned vectors from the Bitcoin base58 test set.
  assert.equal(base58Encode(Uint8Array.from([0x61])), '2g');
  assert.equal(base58Encode(new Uint8Array(10)), '1111111111');
  assert.equal(base58Encode(Uint8Array.from(Buffer.from('73696d706c792061206c6f6e6720737472696e67', 'hex'))), '2cFupjhnEsSn59qHXstmK2ffpLv2');
  assert.equal(
    base58Encode(Uint8Array.from(Buffer.from('00eb15231dfceb60925886b67d065299925915aeb172c06647', 'hex'))),
    '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L',
  );

  // Round trip over random bytes, including leading zeros.
  for (let i = 0; i < 50; i += 1) {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => (index === 0 ? 0 : (i * 7 + index * 13) % 256));
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
});

test('siws: a real signature over the challenge creates a session', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  const challenge = await requestChallenge(app, wallet.address);
  assert.equal(challenge.knownWallet, false);
  assert.ok(challenge.message.includes(wallet.address), 'the message must carry the address');
  assert.ok(challenge.message.includes(challenge.nonce), 'the message must carry the nonce');

  const { status, json } = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: wallet.sign(challenge.message),
    role: 'curator',
    displayName: 'Wallet-first Curator',
    countryCode: 'AE',
    email: 'curator@example.com',
  });

  assert.equal(status, 201, `verify failed: ${JSON.stringify(json)}`);
  assert.equal(json.created, true);
  assert.equal(json.actor.walletAddress, wallet.address);
  assert.equal(json.actor.role, 'curator');
  assert.equal(json.actor.verification, 'none', 'business roles stay unverified until KYB');
  assert.ok(typeof json.token === 'string' && json.token.length > 20);

  const session = await app.request('/api/auth/session', { headers: { authorization: `Bearer ${json.token}` } });
  assert.equal(session.status, 200);
  const sessionBody = (await session.json()) as Record<string, any>;
  assert.equal(sessionBody.actor.id, json.actor.id);
  assert.equal(sessionBody.walletAddress, wallet.address);
});

test('siws: a tampered message, a wrong key, and a tampered signature are all refused', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();
  const attacker = newWallet();

  const challenge = await requestChallenge(app, wallet.address);

  // Signed by someone else.
  const wrongKey = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: attacker.sign(challenge.message),
    displayName: 'Attacker',
  });
  assert.equal(wrongKey.status, 401);
  assert.equal(wrongKey.json.error?.code, 'BAD_SIGNATURE');

  // Correct key, but the message was altered (a different nonce/statement).
  const tampered = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: wallet.sign(challenge.message.replace(wallet.address, attacker.address)),
    displayName: 'Attacker',
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.json.error?.code, 'BAD_SIGNATURE');

  // A valid signature, one byte of it flipped.
  const signatureBytes = base58Decode(wallet.sign(challenge.message));
  signatureBytes[0] = signatureBytes[0]! ^ 0xff;
  const flipped = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: base58Encode(signatureBytes),
    displayName: 'Attacker',
  });
  assert.equal(flipped.status, 401);
  assert.equal(flipped.json.error?.code, 'BAD_SIGNATURE');

  // None of the failures above may burn the challenge; the real owner still gets in.
  const good = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: wallet.sign(challenge.message),
    displayName: 'Real Owner',
  });
  assert.equal(good.status, 201, JSON.stringify(good.json));
});

test('siws: a nonce is single-use and cannot be replayed', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  const challenge = await requestChallenge(app, wallet.address);
  const signature = wallet.sign(challenge.message);

  const first = await verify(app, { walletAddress: wallet.address, nonce: challenge.nonce, signature, displayName: 'Buyer One' });
  assert.equal(first.status, 201);

  const replay = await verify(app, { walletAddress: wallet.address, nonce: challenge.nonce, signature });
  assert.equal(replay.status, 409, 'a replayed challenge must not mint a second session');
  assert.equal(replay.json.error?.code, 'CHALLENGE_USED');
});

test('siws: an expired challenge is refused even with a valid signature', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  const challenge = await requestChallenge(app, wallet.address);
  const signature = wallet.sign(challenge.message);

  // Force the stored challenge into the past.
  db.prepare('UPDATE auth_nonces SET expires_at = ? WHERE nonce = ?').run('2020-01-01T00:00:00.000Z', challenge.nonce);

  const res = await verify(app, { walletAddress: wallet.address, nonce: challenge.nonce, signature, displayName: 'Slow Signer' });
  assert.equal(res.status, 409);
  assert.equal(res.json.error?.code, 'CHALLENGE_EXPIRED');
});

test('a missing profile does not burn the challenge (one wallet prompt, not two)', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  const challenge = await requestChallenge(app, wallet.address);
  const signature = wallet.sign(challenge.message);

  // First attempt: the wallet has no account and no display name was collected.
  const first = await verify(app, { walletAddress: wallet.address, nonce: challenge.nonce, signature });
  assert.equal(first.status, 400);
  assert.equal(first.json.error?.code, 'PROFILE_REQUIRED');

  // The SAME signature and nonce must still work once the profile arrives,
  // otherwise the client would have to ask the wallet to sign twice.
  const second = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature,
    displayName: 'Second Attempt Buyer',
  });
  assert.equal(second.status, 201, JSON.stringify(second.json));
});

test('siws: an unknown nonce and a malformed address are rejected', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  // displayName is supplied so the profile gate passes and the unknown nonce is
  // what actually gets rejected here.
  const unknown = await verify(app, {
    walletAddress: wallet.address,
    nonce: 'f'.repeat(32),
    signature: 'x'.repeat(40),
    displayName: 'Unknown Nonce Buyer',
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error?.code, 'CHALLENGE_NOT_FOUND');

  const badAddress = await app.request('/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress: 'not-a-solana-address' }),
  });
  assert.equal(badAddress.status, 400);
});

test('a session token grants identity-based write access, and sign-out revokes it', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const wallet = newWallet();

  const challenge = await requestChallenge(app, wallet.address);
  const { json } = await verify(app, {
    walletAddress: wallet.address,
    nonce: challenge.nonce,
    signature: wallet.sign(challenge.message),
    role: 'curator',
    displayName: 'Token Curator',
    countryCode: 'AE',
    email: 'token-curator@example.com',
  });
  assert.equal(json.created, true);
  const token = String(json.token);
  const actorId = String(json.actor.id);

  // Affiliations require the caller to BE this actor (or a curator): the token
  // is the only reason this request is allowed.
  const other = await app.request('/api/actors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'seller', displayName: 'Affiliate Target', email: 'target@example.com', countryCode: 'AE' }),
  });
  const otherId = String(((await other.json()) as Record<string, any>).actor.id);

  const write = await app.request(`/api/actors/${actorId}/affiliations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ relatedActorId: otherId, note: 'same ownership group' }),
  });
  assert.equal(write.status, 201, await write.text());

  const signout = await app.request('/api/auth/signout', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  assert.equal(signout.status, 200);
  assert.equal(((await signout.json()) as Record<string, any>).revoked, true);

  const afterSignout = await app.request(`/api/actors/${actorId}/affiliations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ relatedActorId: otherId }),
  });
  assert.equal(afterSignout.status, 403, 'a revoked token must not keep working');
});

test('with demo mode off the x-actor-id header stops granting identity', async () => {
  const previous = process.env.VIN_DEMO_MODE;
  process.env.VIN_DEMO_MODE = 'false';
  try {
    const db = openDb(':memory:');
    const app = createApp(db);
    const wallet = newWallet();

    // A real session still works with demo mode off.
    const challenge = await requestChallenge(app, wallet.address);
    const { json } = await verify(app, {
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.sign(challenge.message),
      role: 'curator',
      displayName: 'Hard Mode Curator',
      countryCode: 'AE',
      email: 'hard@example.com',
    });
    const actorId = String(json.actor.id);
    const withToken = await app.request('/api/auth/session', { headers: { authorization: `Bearer ${json.token}` } });
    assert.equal(withToken.status, 200);

    // The demo header alone is now nothing.
    const headerOnly = await app.request(`/api/actors/${actorId}/affiliations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': actorId },
      body: JSON.stringify({ relatedActorId: actorId }),
    });
    assert.equal(headerOnly.status, 403, 'x-actor-id must not authenticate when demo mode is off');

    const methods = (await (await app.request('/api/auth/methods')).json()) as Record<string, any>;
    assert.equal(methods.demoMode, false);
    assert.equal(methods.demoHeaderAccepted, false);
  } finally {
    if (previous === undefined) delete process.env.VIN_DEMO_MODE;
    else process.env.VIN_DEMO_MODE = previous;
  }
});

test('auth methods are reported honestly (social login is not built)', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const methods = (await (await app.request('/api/auth/methods')).json()) as Record<string, any>;
  const byId = Object.fromEntries((methods.methods as Record<string, any>[]).map((entry) => [entry.id, entry]));
  assert.equal(byId.wallet.implemented, true);
  assert.equal(byId.google.implemented, false);
  assert.equal(byId.x.implemented, false);
});

/** Keep the unused-import checker honest: DatabaseSync is used via openDb. */
export type _DatabaseSync = DatabaseSync;
