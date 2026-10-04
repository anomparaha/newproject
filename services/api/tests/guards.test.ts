/**
 * Anti-regression guards for three guard-clause returns that an i18n refactor
 * once silently dropped (each `return c.json(...)` had degraded into a bare
 * `message: '...'` labeled statement). Two of the three were "silent" — they
 * returned 200 instead of an error, so the Postman "no server error" check
 * could not catch them. These tests pin the exact status + error code so the
 * regression cannot come back unnoticed. Run: npm test
 *
 *  - GET /api/reputation/:id for an unknown actor -> 404 NOT_FOUND
 *    (was 200 { reputation: null })
 *  - GET /api/demo/actors when VIN_DEMO_MODE=false -> 404 NOT_FOUND
 *    (was 200 leaking the actor list)
 *
 * The third bug (resolving an already-resolved dispute -> 409 INVALID_TRANSITION,
 * was a 500) is guarded in the Postman collection: "E2E Dispute Path" step 12,
 * where a resolved dispute already exists to re-resolve.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

test('reputation of an unknown actor returns 404 NOT_FOUND', async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const res = await app.request('/api/reputation/does-not-exist-xyz');
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, 'NOT_FOUND');
});

test('GET /api/demo/actors returns 404 when VIN_DEMO_MODE=false', async () => {
  const previous = process.env.VIN_DEMO_MODE;
  process.env.VIN_DEMO_MODE = 'false';
  try {
    const db = openDb(':memory:');
    const app = createApp(db);
    const res = await app.request('/api/demo/actors');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, 'NOT_FOUND');
  } finally {
    if (previous === undefined) delete process.env.VIN_DEMO_MODE;
    else process.env.VIN_DEMO_MODE = previous;
  }
});

test('GET /api/demo/actors still works when demo mode is on', async () => {
  const previous = process.env.VIN_DEMO_MODE;
  delete process.env.VIN_DEMO_MODE;
  try {
    const db = openDb(':memory:');
    const app = createApp(db);
    const res = await app.request('/api/demo/actors');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { demoMode?: boolean; actors?: unknown[] };
    assert.equal(body.demoMode, true);
    assert.ok(Array.isArray(body.actors));
  } finally {
    if (previous === undefined) delete process.env.VIN_DEMO_MODE;
    else process.env.VIN_DEMO_MODE = previous;
  }
});
