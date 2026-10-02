/**
 * Seed demo VIN.
 *
 * Skrip ini TIDAK menulis langsung ke basis data. Ia menjalankan API yang sama
 * lalu memanggil endpoint-nya lewat HTTP, sehingga sekaligus menjadi uji integrasi
 * alur utama: listing -> escrow -> inspeksi -> serah terima -> nota, plus satu
 * kasus anomali kilometer + sengketa.
 *
 * Pakai: npm run seed -- --reset
 */

import { serve } from '@hono/node-server';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, dbPath, REPO_ROOT } from './db.js';
import { createApp } from './app.js';
import { recomputeAll } from './reputation.js';

const reset = process.argv.includes('--reset');

interface Ctx {
  base: string;
}

async function call<T>(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  actorId?: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(extraHeaders ?? {}) };
  if (actorId) headers['x-actor-id'] = actorId;
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return parsed as T;
}

async function main(): Promise<void> {
  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath()}${suffix}`, { force: true });
    }
    console.log('[seed] basis data direset');
  }

  const db = openDb();
  const app = createApp(db);

  await new Promise<void>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      const ctx: Ctx = { base: `http://127.0.0.1:${info.port}` };
      void runSeed(ctx, db).finally(() => {
        server.close(() => resolve());
      });
    });
  });
}

async function runSeed(ctx: Ctx, db: ReturnType<typeof openDb>): Promise<void> {
  const existing = await call<{ actors: Array<{ id: string; role: string }> }>(ctx, 'GET', '/api/actors');
  if (existing.actors.length > 0 && !reset) {
    console.log(`[seed] sudah ada ${existing.actors.length} aktor. Jalankan "npm run seed -- --reset" untuk memulai ulang.`);
    return;
  }

  // ---------------------------------------------------------------------
  // Aktor
  // ---------------------------------------------------------------------
  const seller = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'seller',
    displayName: 'Anoodize Motors (dealer, Jakarta)',
    email: 'seller@vin.demo',
    countryCode: 'ID',
    city: 'Jakarta',
    walletAddress: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  });
  const buyer = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'buyer',
    displayName: 'Straits Auto Pte Ltd (Singapura)',
    email: 'buyer@vin.demo',
    countryCode: 'SG',
    city: 'Singapore',
    walletAddress: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  });
  const inspector1 = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'inspector',
    displayName: 'Bengkel Inspeksi Nusantara',
    email: 'inspeksi1@vin.demo',
    countryCode: 'ID',
    city: 'Jakarta',
  });
  const inspector2 = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'inspector',
    displayName: 'Sahabat Motor (terafiliasi Anoodize)',
    email: 'inspeksi2@vin.demo',
    countryCode: 'ID',
    city: 'Jakarta',
  });
  const curator = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'curator',
    displayName: 'Kurator Koridor ID-SG',
    email: 'curator@vin.demo',
    countryCode: 'ID',
    city: 'Jakarta',
  });
  const arbiter = await call<{ actor: { id: string } }>(ctx, 'POST', '/api/actors', {
    role: 'arbiter',
    displayName: 'Arbiter VIN',
    email: 'arbiter@vin.demo',
    countryCode: 'SG',
    city: 'Singapore',
  });

  // Verifikasi identitas usaha (kurator)
  await call(ctx, 'POST', `/api/actors/${seller.actor.id}/verify`, { level: 'business_verified' }, curator.actor.id);
  await call(ctx, 'POST', `/api/actors/${inspector1.actor.id}/verify`, { level: 'business_verified' }, curator.actor.id);
  await call(ctx, 'POST', `/api/actors/${inspector2.actor.id}/verify`, { level: 'business_verified' }, curator.actor.id);

  // Afiliasi penjual <-> bengkel 2 (supaya diblokir dari order penjual ini)
  await call(
    ctx,
    'POST',
    `/api/actors/${seller.actor.id}/affiliations`,
    { relatedActorId: inspector2.actor.id, note: 'Satu grup usaha dengan dealer' },
    curator.actor.id,
  );

  // Jaminan bengkel
  for (const inspector of [inspector1, inspector2]) {
    await call(ctx, 'POST', `/api/actors/${inspector.actor.id}/bonds`, {
      amount: '25',
      currency: 'USDC',
      purpose: 'inspection_capacity',
    });
  }

  // ---------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------
  const hash = (n: number) => n.toString(16).padStart(64, '0');

  const listing1 = await call<{ listing: { id: string } }>(ctx, 'POST', '/api/listings', {
    vin: 'JTDKAMFU1M3123456',
    sellerId: seller.actor.id,
    make: 'Toyota',
    model: 'Alphard 2.5 G',
    year: 2021,
    odometerKm: 30000,
    location: 'Jakarta Selatan, Indonesia',
    priceAmount: '45000',
    priceCurrency: 'USDC',
    shippingTerms: 'FOB Jakarta, ongkir ditanggung pembeli',
    photoHashes: [hash(1), hash(2), hash(3)],
    bond: { amount: '50', currency: 'USDC' },
  });

  const listing2 = await call<{ listing: { id: string } }>(ctx, 'POST', '/api/listings', {
    vin: 'JTMHV05J204098765',
    sellerId: seller.actor.id,
    make: 'Toyota',
    model: 'Land Cruiser 200',
    year: 2020,
    odometerKm: 68000,
    location: 'Jakarta Barat, Indonesia',
    priceAmount: '68000',
    priceCurrency: 'USDC',
    shippingTerms: 'FOB Jakarta, ongkir ditanggung pembeli',
    photoHashes: [hash(4), hash(5)],
    bond: { amount: '50', currency: 'USDC' },
  });

  const listing3 = await call<{ listing: { id: string } }>(ctx, 'POST', '/api/listings', {
    vin: 'MRHRU5850LP123456',
    sellerId: seller.actor.id,
    make: 'Honda',
    model: 'Vezel Hybrid Z',
    year: 2019,
    odometerKm: 52000,
    location: 'Surabaya, Indonesia',
    priceAmount: '12000',
    priceCurrency: 'USD',
    shippingTerms: 'FOB Surabaya',
    photoHashes: [hash(6)],
  });

  console.log(`[seed] 3 listing dibuat. Di bawah ambang koridor = tanpa jaminan (${listing3.listing.id}).`);

  // ---------------------------------------------------------------------
  // Deal A: alur bersih sampai nota
  // ---------------------------------------------------------------------
  const dealA = await call<{ deal: { id: string } }>(
    ctx,
    'POST',
    `/api/listings/${listing1.listing.id}/deals`,
    {
      buyerId: buyer.actor.id,
      inspectorId: inspector1.actor.id,
      shippingPaidBy: 'buyer',
      shippingAmount: '1200',
      inspectionFeeAmount: '150',
      escrowCurrency: 'USDC',
      inspectionDeadlineHours: 72,
      handoverTerms: 'Serah di lokasi Jakarta + bukti muat; konfirmasi kedua pihak',
    },
    buyer.actor.id,
  );
  await call(ctx, 'POST', `/api/deals/${dealA.deal.id}/fund`, { payerRef: buyer.actor.id }, buyer.actor.id, {
    'x-demo-backdate-hours': '40',
  });

  const reportA = await call<{ report: { id: string } }>(
    ctx,
    'POST',
    `/api/deals/${dealA.deal.id}/reports`,
    {
      inspectorId: inspector1.actor.id,
      odometerKm: 30240,
      inspectedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      reportHash: hash(11),
      dashboardPhotoHash: hash(12),
      conditionSummary: 'Cat dasar rapi, tidak ada bekas tabrakan struktur. Ban 80%, AC dingin, riwayat servis lengkap.',
      standardVersion: 'vin-report-v1',
      checklist: {
        vin_matches_unit: true,
        dashboard_photo: true,
        odometer_documented: true,
        main_condition: true,
        date_and_location: true,
      },
    },
    inspector1.actor.id,
    { 'x-demo-backdate-hours': '32' },
  );
  await call(
    ctx,
    'POST',
    `/api/deals/${dealA.deal.id}/reports/${reportA.report.id}/accept`,
    { buyerId: buyer.actor.id },
    buyer.actor.id,
  );
  await call(ctx, 'POST', `/api/deals/${dealA.deal.id}/handover`, { actorId: buyer.actor.id, method: 'load_proof' }, buyer.actor.id);
  await call(
    ctx,
    'POST',
    `/api/deals/${dealA.deal.id}/handover`,
    { actorId: seller.actor.id, method: 'load_proof' },
    seller.actor.id,
  );
  const completed = await call<{ note: { id: string; evidenceRoot: string } }>(
    ctx,
    'POST',
    `/api/deals/${dealA.deal.id}/release-vehicle`,
    undefined,
    seller.actor.id,
  );
  console.log(`[seed] Deal A selesai. Nota ${completed.note.id} (evidence root ${completed.note.evidenceRoot.slice(0, 12)}...)`);

  // ---------------------------------------------------------------------
  // Deal B: anomali kilometer -> sengketa -> jaminan terpotong
  // ---------------------------------------------------------------------
  const dealB = await call<{ deal: { id: string } }>(
    ctx,
    'POST',
    `/api/listings/${listing2.listing.id}/deals`,
    {
      buyerId: buyer.actor.id,
      inspectorId: inspector1.actor.id,
      shippingPaidBy: 'buyer',
      shippingAmount: '1500',
      inspectionFeeAmount: '150',
      escrowCurrency: 'USDC',
      inspectionDeadlineHours: 48,
      handoverTerms: 'Serah di lokasi Jakarta, konfirmasi kedua pihak',
    },
    buyer.actor.id,
  );
  await call(ctx, 'POST', `/api/deals/${dealB.deal.id}/fund`, { payerRef: buyer.actor.id }, buyer.actor.id, {
    'x-demo-backdate-hours': '30',
  });
  const reportB = await call<{ report: { id: string }; anomaly: { flagged: boolean; previousOdometerKm?: number | null } }>(
    ctx,
    'POST',
    `/api/deals/${dealB.deal.id}/reports`,
    {
      inspectorId: inspector1.actor.id,
      odometerKm: 45000,
      inspectedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      reportHash: hash(21),
      dashboardPhotoHash: hash(22),
      conditionSummary: 'Odometer 45.000 km, lebih rendah dari catatan platform (68.000 km). Perlu penjelasan dokumen servis.',
      standardVersion: 'vin-report-v1',
      checklist: {
        vin_matches_unit: true,
        dashboard_photo: true,
        odometer_documented: true,
        main_condition: true,
        date_and_location: true,
      },
    },
    inspector1.actor.id,
    { 'x-demo-backdate-hours': '4' },
  );
  console.log(`[seed] Anomali kilometer ditandai: ${reportB.anomaly.flagged} (catatan sebelumnya ${reportB.anomaly.previousOdometerKm})`);

  const dispute = await call<{ dispute: { id: string } }>(
    ctx,
    'POST',
    `/api/deals/${dealB.deal.id}/disputes`,
    { openedBy: buyer.actor.id, reason: 'Penjual tidak menyerahkan unit pada tanggal yang disepakati dan tidak bisa menjelaskan selisih odometer.' },
    buyer.actor.id,
  );
  const resolved = await call<{ dispute: { outcome: string; bondSlashedAmount: string | null } }>(
    ctx,
    'POST',
    `/api/disputes/${dispute.dispute.id}/resolve`,
    {
      arbiterId: arbiter.actor.id,
      outcome: 'bond_slashed',
      arbiterNote: 'Penjual tidak menyerahkan unit. Dana kembali ke pembeli; jaminan terpotong dan masuk kas sengketa.',
    },
    arbiter.actor.id,
  );
  console.log(`[seed] Sengketa diputus: ${resolved.dispute.outcome}, jaminan terpotong ${resolved.dispute.bondSlashedAmount}`);

  // ---------------------------------------------------------------------
  // Deal C: berjalan (inspeksi belum ada laporan)
  // ---------------------------------------------------------------------
  const dealC = await call<{ deal: { id: string } }>(
    ctx,
    'POST',
    `/api/listings/${listing3.listing.id}/deals`,
    {
      buyerId: buyer.actor.id,
      inspectorId: inspector1.actor.id,
      shippingPaidBy: 'seller',
      shippingAmount: '0',
      inspectionFeeAmount: '100',
      escrowCurrency: 'USDC',
      inspectionDeadlineHours: 96,
      handoverTerms: 'Serah di lokasi Surabaya',
    },
    buyer.actor.id,
  );
  await call(ctx, 'POST', `/api/deals/${dealC.deal.id}/fund`, { payerRef: buyer.actor.id }, buyer.actor.id, {
    'x-demo-backdate-hours': '2',
  });

  // Reputasi dihitung ulang dari event
  recomputeAll(db);

  const seedFile = `${REPO_ROOT}/.data/seed.json`;
  mkdirSync(dirname(seedFile), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    actors: {
      seller: seller.actor.id,
      buyer: buyer.actor.id,
      inspectorVerified: inspector1.actor.id,
      inspectorAffiliated: inspector2.actor.id,
      curator: curator.actor.id,
      arbiter: arbiter.actor.id,
    },
    listings: {
      cleanPath: listing1.listing.id,
      anomalyAndDispute: listing2.listing.id,
      belowThreshold: listing3.listing.id,
    },
    deals: { completed: dealA.deal.id, disputed: dealB.deal.id, inProgress: dealC.deal.id },
    note: completed.note.id,
  };
  writeFileSync(seedFile, JSON.stringify(payload, null, 2));
  console.log(`[seed] ID demo ditulis ke ${seedFile}`);
  console.log('[seed] Buka GET /api/vin/JTDKAMFU1M3123456 untuk melihat rangkaian event per VIN.');
}

main()
  .catch((err) => {
    console.error('[seed] gagal:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Database ditutup oleh proses; hindari handle terbuka yang menahan exit.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50);
  });
