/**
 * Uji asap (smoke test) untuk CI.
 *
 * Menjalankan API yang sama pada port sementara, lalu memeriksa janji-janji inti:
 *  - kebijakan publik bisa dibaca,
 *  - halaman VIN memuat rangkaian event,
 *  - dana kendaraan TIDAK bisa dilepas tanpa syarat serah terima,
 *  - nota hanya ada untuk deal selesai.
 *
 * Pakai: npm run smoke   (butuh data: npm run seed:reset)
 */

import { serve } from '@hono/node-server';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbPath, openDb } from './db.js';
import { createApp } from './app.js';

/**
 * Uji asap berjalan di SALINAN basis data demo supaya data yang dipakai di layar
 * tidak ikut berubah karena pengujian.
 */
function useTemporaryCopyOfDemoDb(): void {
  const source = dbPath();
  if (!existsSync(source)) {
    console.log('[smoke] basis data belum ada; jalankan npm run seed:reset lebih dulu');
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
    console.log(`  GAGAL ${name}${detail ? ` — ${detail}` : ''}`);
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
    console.error(`\n[smoke] ${failures} pemeriksaan gagal`);
    process.exit(1);
  }
  console.log('\n[smoke] semua pemeriksaan lolos');
}

async function runChecks(base: string): Promise<void> {
  console.log('[smoke] memeriksa API VIN');

  const health = await fetch(`${base}/api/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  check('health mengembalikan status ok', health.status === 'ok');

  const policy = await fetch(`${base}/api/meta/policy`).then((r) => r.json() as Promise<Record<string, any>>);
  check('kebijakan memuat tiga fungsi token', policy.token?.functions?.length === 3);
  check(
    'token tidak pernah membeli harga kendaraan',
    policy.token?.neverDoes?.includes('membeli_harga_kendaraan') === true,
  );
  check('uang kendaraan hanya stablecoin/fiat', typeof policy.moneyRule === 'string' && policy.moneyRule.length > 20);
  check('taksonomi event berisi 10 tipe', policy.eventTypes?.length === 10);

  const vin = await fetch(`${base}/api/vin/JTDKAMFU1M3123456`).then((r) => r.json() as Promise<Record<string, any>>);
  check('halaman VIN memuat event', Array.isArray(vin.events) && vin.events.length > 0, `events=${vin.events?.length}`);
  check(
    'nomor urut event berurutan dari 1',
    Array.isArray(vin.events) && vin.events.every((e: { seq: number }, i: number) => e.seq === i + 1),
  );
  check('halaman VIN menulis batas klaim', typeof vin.claimsBoundary === 'string' && vin.claimsBoundary.includes('bukan title'));
  check('halaman VIN menulis batas keunikan', typeof vin.notice === 'string' && vin.notice.includes('unik'));

  const metrics = await fetch(`${base}/api/corridors/cor_id_sg/metrics`).then((r) => r.json() as Promise<Record<string, any>>);
  check('metrik koridor bisa dibaca', typeof metrics.metrics?.dealsCompleted === 'number');
  check(
    'metrik memuat tiga angka publik',
    typeof metrics.metrics?.dealsCompleted === 'number' &&
      typeof metrics.metrics?.disputeRate === 'number' &&
      'medianHoursToReport' in (metrics.metrics ?? {}),
  );

  const listings = await fetch(`${base}/api/listings`).then((r) => r.json() as Promise<Record<string, any>>);
  const listing = (listings.listings ?? []).find((l: { status: string }) => l.status === 'listed');
  check('ada listing untuk diuji', Boolean(listing));

  if (listing) {
    // Deal baru tanpa pendanaan: pelepasan dana harus ditolak.
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
          handoverTerms: 'Serah di lokasi; konfirmasi kedua pihak',
        }),
      }).then((r) => r.json() as Promise<Record<string, any>>);
      const dealId = commit.deal?.id;
      check('deal bisa dikunci pembeli', Boolean(dealId));

      if (dealId) {
        const earlyRelease = await fetch(`${base}/api/deals/${dealId}/release-vehicle`, {
          method: 'POST',
          headers: { 'x-actor-id': buyer.id },
        });
        check(
          'dana kendaraan ditolak sebelum syarat terpenuhi',
          earlyRelease.status === 409,
          `status=${earlyRelease.status}`,
        );

        const escrows = await fetch(`${base}/api/deals/${dealId}/escrows`).then((r) => r.json() as Promise<Record<string, any>>);
        check('dua escrow terpisah dibuat', escrows.escrows?.length === 2);
        check(
          'leg escrow berbeda (vehicle & inspection)',
          new Set((escrows.escrows ?? []).map((e: { leg: string }) => e.leg)).size === 2,
        );
      }
    } else {
      check('ada pembeli & bengkel untuk uji deal', Boolean(buyer && inspector), 'jalankan npm run seed:reset');
    }
  }

  // Invarian yang sama dengan model ledger & program Anchor:
  // deal yang sudah selesai/dibatalkan TIDAK BOLEH punya escrow yang masih
  // menggantung (funded/frozen) - itu tanda dana tersangkut.
  const deals = await fetch(`${base}/api/deals`).then((r) => r.json() as Promise<Record<string, any>>);
  const settled = (deals.deals ?? []).filter((d: { state: string }) => d.state === 'completed' || d.state === 'cancelled');
  check('ada deal yang sudah ditutup untuk diperiksa', settled.length > 0);

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
  check('tidak ada dana tersangkut di deal yang sudah ditutup', stranded.length === 0, stranded.join(', '));
  check('bengkel tetap dibayar saat sengketa diputus (laporan sudah ada)', inspectionPaidInDispute);

  const notes = await fetch(`${base}/api/notes`).then((r) => r.json() as Promise<Record<string, any>>);
  check('ada nota untuk deal selesai', Array.isArray(notes.notes) && notes.notes.length > 0);
  if (notes.notes?.length > 0) {
    const noteId = notes.notes[0].id;
    const metadata = await fetch(`${base}/api/notes/${noteId}/metadata`).then((r) => r.json() as Promise<Record<string, any>>);
    check('metadata nota kompatibel Metaplex Core', Array.isArray(metadata.attributes) && typeof metadata.name === 'string');
    check(
      'metadata nota menyatakan bukan surat kendaraan',
      typeof metadata.properties?.vin_notice === 'string' && metadata.properties.vin_notice.includes('bukan title'),
    );
  }
}

main().catch((error) => {
  console.error('[smoke] error:', error);
  process.exit(1);
});
