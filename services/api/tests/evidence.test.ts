/**
 * Evidence upload + content-addressed storage tests.
 *
 * These prove the gap called out in VehiclePhoto is now closed: a caller can
 * upload bytes, the server hashes them itself, and the same hash fetches the
 * exact bytes back. The hash is the only thing meant to travel further.
 *
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { MemoryObjectStore, sha256Hex } from '../src/storage.js';

const DATA_B64 = Buffer.from('VIN evidence — a dashboard photo stands in for real bytes').toString('base64');

function appWithMemoryStore() {
  const db = openDb(':memory:');
  const store = new MemoryObjectStore();
  return { app: createApp(db, { store }), store };
}

const AUTHED = { 'content-type': 'application/json', 'x-actor-id': 'act_tester' } as const;

test('evidence: upload stores content-addressed and returns the server-computed sha256', async () => {
  const { app } = appWithMemoryStore();
  const bytes = Buffer.from(DATA_B64, 'base64');
  const expected = sha256Hex(new Uint8Array(bytes));

  const res = await app.request('/api/evidence', {
    method: 'POST',
    headers: AUTHED,
    body: JSON.stringify({ contentType: 'image/png', dataBase64: DATA_B64, filename: 'proof.png' }),
  });
  assert.equal(res.status, 201);
  const json = (await res.json()) as Record<string, any>;
  assert.equal(json.hash, expected, 'the hash is the sha256 of the bytes, computed by the server');
  assert.equal(json.size, bytes.byteLength);
  assert.equal(json.url, `/api/evidence/${expected}`);
  assert.equal(json.filename, 'proof.png');
});

test('evidence: identical bytes dedupe to the same id (idempotent)', async () => {
  const { app, store } = appWithMemoryStore();
  const body = JSON.stringify({ contentType: 'image/png', dataBase64: DATA_B64 });
  const first = (await (await app.request('/api/evidence', { method: 'POST', headers: AUTHED, body })).json()) as Record<string, any>;
  const second = (await (await app.request('/api/evidence', { method: 'POST', headers: AUTHED, body })).json()) as Record<string, any>;
  assert.equal(first.hash, second.hash);
  assert.ok(store.has(first.hash));
});

test('evidence: stored bytes fetch back by hash and still match the hash', async () => {
  const { app } = appWithMemoryStore();
  const uploaded = (await (await app.request('/api/evidence', {
    method: 'POST',
    headers: AUTHED,
    body: JSON.stringify({ contentType: 'image/png', dataBase64: DATA_B64 }),
  })).json()) as Record<string, any>;

  const got = await app.request(`/api/evidence/${uploaded.hash}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await got.arrayBuffer());
  assert.equal(sha256Hex(bytes), uploaded.hash, 'content-addressed: the served bytes verify against the id');
});

test('evidence: anonymous uploads are refused, and bad/missing hashes are handled', async () => {
  const { app } = appWithMemoryStore();

  const anon = await app.request('/api/evidence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentType: 'image/png', dataBase64: DATA_B64 }),
  });
  assert.equal(anon.status, 401, 'no identity -> no upload');

  const badHash = await app.request('/api/evidence/not-a-valid-hash');
  assert.equal(badHash.status, 400);

  const missing = await app.request(`/api/evidence/${'a'.repeat(64)}`);
  assert.equal(missing.status, 404);
});

test('evidence: an unsupported content type is rejected (nothing executable)', async () => {
  const { app } = appWithMemoryStore();
  const res = await app.request('/api/evidence', {
    method: 'POST',
    headers: AUTHED,
    body: JSON.stringify({ contentType: 'application/x-msdownload', dataBase64: DATA_B64 }),
  });
  assert.equal(res.status, 415);
});
