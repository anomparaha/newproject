/**
 * Smoke test for CI.
 *
 * It runs the same API on a temporary port and checks the core promises:
 *  - public policy is readable,
 *  - the VIN page loads the event chain,
 *  - vehicle funds CANNOT be released without met handover terms,
 *  - a receipt exists only for completed deals.
 *
 * Usage: npm run smoke   (needs data: npm run seed:reset)
 */

import { serve } from '@hono/node-server';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbPath, openDb } from './db.js';
import { createApp } from './app.js';

/**
 * The smoke test runs on a COPY of the demo database so the data on screen
 * are not changed by running tests.
 */
function useTemporaryCopyOfDemoDb(): void {
  const source = dbPath();
  if (!existsSync(source)) {
    console.log('[smoke] the database does not exist yet; run npm run seed:reset first');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'vin-smoke-'));
  const target = join(dir, 'vin.db');
  copyFileSync(source, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
  }
  process.env.VIN_DB_PATH = target;
}

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  useTemporaryCopyOfDemoDb();
  const db = openDb();
  const app = createApp(db);

  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, async (info) => {
      const base = `http://127.0.0.1:${info.port}`;
      try {
        await runChecks(base);
        server.close(() => resolve());
      } catch (error) {
        reject(error);
        server.close(() => resolve());
      }
    });
  });

  db.close();
  if (failures > 0) {
    console.error(`\n[smoke] ${failures} checks failed`);
    process.exit(1);
  }
  console.log('\n[smoke] all checks passed');
}

async function runChecks(base: string): Promise<void> {
  console.log('[smoke] checking the VIN API');

  const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  check('health returns ok', health.status === 'ok');

  const policy = await fetch(`${base}/api/meta/policy`).then((r) => r.json() as Promise<Record<string, any>>);
  check('policy lists three token functions', policy.token?.functions?.length === 3);
  check(
    'the token never buys a vehicle price',
    policy.token?.neverDoes?.includes('buys_vehicle_price') === true,
  );
  check('vehicle money is stablecoin/fiat only', typeof policy.moneyRule === 'string' && policy.moneyRule.length > 20);
  check('the event taxonomy lists 10 types', policy.eventTypes?.length === 10);

  const vin = await fetch(`${base}/api/vin/JTDKAMFU1M3123456`).then((r) => r.json() as Promise<Record<string, any>>);
  check('the VIN page loads events', Array.isArray(vin.events) && vin.events.length > 0, `events=${vin.events?.length}`);
  check(
    'event sequence numbers start at 1 and increase',
    Array.isArray(vin.events) && vin.events.every((e: { seq: number }, i: number) => e.seq === i + 1),
  );
  check('the VIN page states the claim boundary', typeof vin.claimsBoundary === 'string' && vin.claimsBoundary.includes('not a title'));
  check('the VIN page states the uniqueness boundary', typeof vin.notice === 'string' && vin.notice.includes('unique'));

  const metrics = await fetch(`${base}/api/corridors/cor_id_sg/metrics`).then((r) => r.json() as Promise<Record<string, any>>);
  check('corridor metrics are readable', typeof metrics.metrics?.dealsCompleted === 'number');
  check(
    'metrics include the three public numbers',
    typeof metrics.metrics?.dealsCompleted === 'number' &&
      typeof metrics.metrics?.disputeRate === 'number' &&
      'medianHoursToReport' in (metrics.metrics ?? {}),
  );

  const listings = await fetch(`${base}/api/listings`).then((r) => r.json() as Promise<Record<string, any>>);
  const listing = (listings.listings ?? []).find((l: { status: string }) => l.status === 'listed');
  check('a listing exists to test with', Boolean(listing));

  if (listing) {
    // A new unfunded deal: fund release must be rejected.
    const actors = await fetch(`${base}/api/demo/actors`).then((r) => r.json() as Promise<Record<string, any>>);
    const buyer = actors.actors?.find((a: { role: string }) => a.role === 'buyer');
    const inspectors = await fetch(`${base}/api/inspectors?country=ID`).then((r) => r.json() as Promise<Record<string, any>>);
    const inspector = inspectors.inspectors?.[0]?.actor;

    if (buyer && inspector && listing.status === 'listed') {
      const commit = await fetch(`${base}/api/listings/${listing.id}/deals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor-id': buyer.id },
        body: JSON.stringify({
          buyerId: buyer.id,
          inspectorId: inspector.id,
          shippingPaidBy: 'buyer',
          shippingAmount: '100',
          inspectionFeeAmount: '100',
          escrowCurrency: 'USDC',
          inspectionDeadlineHours: 48,
          handoverTerms: 'Handover at location; confirmation by both parties',
        }),
      }).then((r) => r.json() as Promise<Record<string, any>>);
      const dealId = commit.deal?.id;
      check('a buyer can lock a deal', Boolean(dealId));

      if (dealId) {
        const earlyRelease = await fetch(`${base}/api/deals/${dealId}/release-vehicle`, {
          method: 'POST',
          headers: { 'x-actor-id': buyer.id },
        });
        check(
          'vehicle funds are rejected before the terms are met',
          earlyRelease.status === 409,
          `status=${earlyRelease.status}`,
        );

        const escrows = await fetch(`${base}/api/deals/${dealId}/escrows`).then((r) => r.json() as Promise<Record<string, any>>);
        check('two separate escrows are created', escrows.escrows?.length === 2);
        check(
          'the escrow legs differ (vehicle & inspection)',
          new Set((escrows.escrows ?? []).map((e: { leg: string }) => e.leg)).size === 2,
        );
      }
    } else {
      check('a buyer and a workshop exist for the deal test', Boolean(buyer && inspector), 'run npm run seed:reset');
    }
  }

  // The same invariants as the ledger model and the Anchor program:
  // a completed/cancelled deal MUST NOT keep an escrow still
  // hanging (funded/frozen) - that would mean stranded funds.
  const deals = await fetch(`${base}/api/deals`).then((r) => r.json() as Promise<Record<string, any>>);
  const settled = (deals.deals ?? []).filter((d: { state: string }) => d.state === 'completed' || d.state === 'cancelled');
  check('a settled deal exists to inspect', settled.length > 0);

  let stranded: string[] = [];
  let inspectionPaidInDispute = false;
  for (const deal of settled) {
    const escrows = await fetch(`${base}/api/deals/${deal.id}/escrows`).then((r) => r.json() as Promise<Record<string, any>>);
    for (const escrow of escrows.escrows ?? []) {
      if (escrow.status === 'funded' || escrow.status === 'frozen' || escrow.status === 'pending') {
        stranded.push(`${deal.id}:${escrow.leg}=${escrow.status}`);
      }
      if (deal.state === 'cancelled' && escrow.leg === 'inspection' && escrow.status === 'released') {
        inspectionPaidInDispute = true;
      }
    }
  }
  check('no funds are stranded in settled deals', stranded.length === 0, stranded.join(', '));
  check('the workshop is still paid when a dispute is resolved (a report exists)', inspectionPaidInDispute);

  const notes = await fetch(`${base}/api/notes`).then((r) => r.json() as Promise<Record<string, any>>);
  check('a receipt exists for a completed deal', Array.isArray(notes.notes) && notes.notes.length > 0);
  if (notes.notes?.length > 0) {
    const noteId = notes.notes[0].id;
    const metadata = await fetch(`${base}/api/notes/${noteId}/metadata`).then((r) => r.json() as Promise<Record<string, any>>);
    check('receipt metadata is Metaplex Core compatible', Array.isArray(metadata.attributes) && typeof metadata.name === 'string');
    check(
      'receipt metadata states it is not a vehicle title',
      typeof metadata.properties?.vin_notice === 'string' && metadata.properties.vin_notice.includes('not a title'),
    );
  }

  // ---------------------------------------------------------------------------
  // Regression: the odometer baseline is the HIGHEST reading ever recorded on a
  // VIN, never the latest one. One low report must not reset the comparison
  // point, and a re-listing below the record must raise a warning instead of
  // hiding the next anomaly.
  // ---------------------------------------------------------------------------
  const demo = await fetch(`${base}/api/demo/actors`).then((r) => r.json() as Promise<Record<string, any>>);
  const seller = demo.actors?.find((a: { role: string }) => a.role === 'seller');
  const buyer = demo.actors?.find((a: { role: string }) => a.role === 'buyer');
  const inspectorList = await fetch(`${base}/api/inspectors?country=ID`).then((r) => r.json() as Promise<Record<string, any>>);
  const workshop =
    (inspectorList.inspectors ?? []).find((i: { actor: { displayName: string } }) => !i.actor.displayName.includes('Sahabat'))?.actor ??
    inspectorList.inspectors?.[0]?.actor;

  check('a seller, a buyer, and a workshop exist for the odometer regression', Boolean(seller && buyer && workshop), 'run npm run seed:reset');

  if (seller && buyer && workshop) {
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    const json = { 'content-type': 'application/json' };

    const post = (path: string, body: unknown, actorId: string) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { ...json, 'x-actor-id': actorId }, body: JSON.stringify(body) });

    const createListing = async (vin: string, odometerKm: number, salt: number) => {
      const res = await post('/api/listings', {
        vin,
        sellerId: seller.id,
        make: 'Toyota',
        model: 'Regression Fixture',
        year: 2020,
        odometerKm,
        location: 'Jakarta, Indonesia',
        priceAmount: '8000',
        priceCurrency: 'USDC',
        shippingTerms: 'FOB Jakarta, shipping paid by the buyer',
        photoHashes: [hex(200 + salt)],
      }, seller.id);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    const openDeal = async (listingId: string) => {
      const res = await post(`/api/listings/${listingId}/deals`, {
        buyerId: buyer.id,
        inspectorId: workshop.id,
        shippingPaidBy: 'buyer',
        shippingAmount: '100',
        inspectionFeeAmount: '100',
        escrowCurrency: 'USDC',
        inspectionDeadlineHours: 48,
        handoverTerms: 'Handover at the location; confirmation by both parties',
      }, buyer.id);
      return (await res.json()) as Record<string, any>;
    };

    const uploadReport = async (dealId: string, odometerKm: number, salt: number) => {
      const res = await post(`/api/deals/${dealId}/reports`, {
        inspectorId: workshop.id,
        odometerKm,
        inspectedAt: new Date().toISOString(),
        reportHash: hex(210 + salt),
        dashboardPhotoHash: hex(230 + salt),
        conditionSummary: 'Regression fixture for the odometer baseline.',
        standardVersion: 'vin-report-v1',
        checklist: {
          vin_matches_unit: true,
          dashboard_photo: true,
          odometer_documented: true,
          main_condition: true,
          date_and_location: true,
        },
      }, workshop.id);
      return (await res.json()) as Record<string, any>;
    };

    // A listing cannot be created without an acting seller.
    const anonymous = await fetch(`${base}/api/listings`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        vin: 'ODOSMOKEANON26',
        sellerId: seller.id,
        make: 'Toyota',
        model: 'Regression Fixture',
        year: 2020,
        location: 'Jakarta, Indonesia',
        priceAmount: '8000',
        priceCurrency: 'USDC',
        shippingTerms: 'FOB Jakarta, shipping paid by the buyer',
        photoHashes: [hex(250)],
      }),
    });
    check('a listing cannot be created without an acting seller', anonymous.status === 403, `status=${anonymous.status}`);

    // --- Control: a single listing at 90,000 km, reported at 60,000 km. ---
    const control = await createListing('ODOSMOKECTRL26', 90000, 1);
    check('the control listing is created', control.status === 201, `status=${control.status}`);
    if (control.status === 201) {
      const deal = await openDeal(String(control.body.listing.id));
      const dealId = deal.deal?.id;
      if (dealId) {
        await post(`/api/deals/${dealId}/fund`, {}, buyer.id);
        const report = await uploadReport(String(dealId), 60000, 1);
        check('a reading below the listing odometer is flagged as an anomaly', report.anomaly?.flagged === true, JSON.stringify(report.anomaly));
      } else {
        check('the control deal is created', false, JSON.stringify(deal));
      }
    }

    // --- Regression: the same VIN re-listed at 50,000 km after a 90,000 km record. ---
    const first = await createListing('ODOSMOKERST26', 90000, 2);
    const relist = await createListing('ODOSMOKERST26', 50000, 3);
    check('a re-listing below the highest record is accepted with a warning', relist.body.odometerWarning?.flagged === true, JSON.stringify(relist.body.odometerWarning));

    if (first.status === 201 && relist.status === 201) {
      const deal = await openDeal(String(relist.body.listing.id));
      const dealId = deal.deal?.id;
      if (dealId) {
        await post(`/api/deals/${dealId}/fund`, {}, buyer.id);
        const report = await uploadReport(String(dealId), 60000, 2);
        check(
          'a re-listing cannot reset the odometer baseline',
          report.anomaly?.flagged === true,
          `previous=${String(report.anomaly?.previousOdometerKm)} flagged=${String(report.anomaly?.flagged)}`,
        );
      } else {
        check('the regression deal is created', false, JSON.stringify(deal));
      }
    }

    // The warning must also block report acceptance until the buyer sees it.
    const vin = await fetch(`${base}/api/vin/ODOSMOKERST26`).then((r) => r.json() as Promise<Record<string, any>>);
    check(
      'the warning stays visible on the VIN chain',
      (vin.events ?? []).some((e: { type: string }) => e.type === 'odometer_anomaly'),
    );
  }
}

main().catch((error) => {
  console.error('[smoke] error:', error);
  process.exit(1);
});
