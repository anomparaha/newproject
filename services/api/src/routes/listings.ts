import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { zCreateListing, vinScopeNotice, type EventPayload } from '@vin/shared';
import { all, get, json, newId, nowIso, run } from '../db.js';
import { actorIdFromRequest, type AppContext } from '../context.js';
import { appendEvent, eventsForVin, latestOdometer } from '../events.js';
import { serializeActor, serializeBond, serializeListing, serializeNote, serializeReport } from '../serialize.js';
import { BONDS, CANDIDATE_CORRIDORS, PILOT_CORRIDOR } from '../policy.js';

/** Kurs sederhana untuk ambang nilai koridor. Produksi: sumber kurs berizin + audit. */
const USD_RATES: Record<string, number> = { USD: 1, USDC: 1, IDR: 1 / 16_200 };

export function listingRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/listings', zValidator('json', zCreateListing), (c) => {
    const input = c.req.valid('json');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const seller = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [input.sellerId]);
    if (!seller) return c.json({ error: { code: 'NOT_FOUND', message: 'Penjual tidak ditemukan' } }, 404);
    if (seller.role !== 'seller') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya akun penjual/dealer yang bisa membuat listing' } }, 403);
    }
    if (callerId && callerId !== input.sellerId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya penjual pemilik akun yang boleh membuat listing atas namanya' } }, 403);
    }

    const rate = USD_RATES[input.priceCurrency];
    if (!rate) return c.json({ error: { code: 'FORBIDDEN', message: `Mata uang ${input.priceCurrency} belum didukung` } }, 400);
    const priceUsd = Number(input.priceAmount) * rate;
    const corridor = PILOT_CORRIDOR;
    if (!corridor) {
      return c.json({ error: { code: 'CORRIDOR_NOT_SERVED', message: 'Koridor belum dilayani' } }, 403);
    }
    const aboveThreshold = priceUsd >= corridor.minVehiclePriceUsd;

    // Di atas ambang nilai: penjual harus terverifikasi dan mengunci jaminan.
    if (aboveThreshold && seller.verification !== 'business_verified') {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `Listing di atas ambang USD ${corridor.minVehiclePriceUsd} memerlukan verifikasi identitas usaha penjual.`,
          },
        },
        403,
      );
    }
    if (aboveThreshold && !input.bond) {
      return c.json(
        {
          error: {
            code: 'BOND_REQUIRED',
            message: `Listing di atas ambang nilai wajib mengunci jaminan (mis. ${BONDS.listingBondUsdc} USDC) sebelum tayang.`,
            details: { suggested: { amount: BONDS.listingBondUsdc, currency: 'USDC' } },
          },
        },
        400,
      );
    }

    const id = newId('lst');
    const createdAt = nowIso();
    run(
      ctx.db,
      `INSERT INTO listings (id, vin, seller_id, make, model, year, odometer_km, location, price_amount, price_currency, price_usd,
        shipping_terms, photo_hashes, status, bond_amount, bond_currency, corridor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed', ?, ?, ?, ?, ?)`,
      [
        id,
        input.vin,
        input.sellerId,
        input.make,
        input.model,
        input.year,
        input.odometerKm ?? null,
        input.location,
        input.priceAmount,
        input.priceCurrency,
        priceUsd,
        input.shippingTerms,
        JSON.stringify(input.photoHashes),
        input.bond?.amount ?? '0',
        input.bond?.currency ?? 'VIN',
        corridor.id,
        createdAt,
        createdAt,
      ],
    );

    let bondRow: Record<string, unknown> | null = null;
    if (input.bond) {
      const bondId = newId('bond');
      run(
        ctx.db,
        `INSERT INTO bonds (id, actor_id, purpose, amount, currency, state, listing_id, reason, locked_at, settled_at)
         VALUES (?, ?, 'listing', ?, ?, 'locked', ?, NULL, ?, NULL)`,
        [bondId, input.sellerId, input.bond.amount, input.bond.currency, id, createdAt],
      );
      bondRow = get(ctx.db, 'SELECT * FROM bonds WHERE id = ?', [bondId]) ?? null;
    }

    const payload: EventPayload = {
      make: input.make,
      model: input.model,
      year: input.year,
      priceAmount: input.priceAmount,
      priceCurrency: input.priceCurrency,
      shippingTerms: input.shippingTerms,
      photoHashes: input.photoHashes,
      odometerKm: input.odometerKm,
    };
    const event = appendEvent(ctx.db, {
      vin: input.vin,
      type: 'listing_created',
      dealId: null,
      payload,
      actorId: input.sellerId,
      actorRole: 'seller',
    });

    return c.json(
      {
        listing: serializeListing(get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [id])!),
        bond: bondRow ? serializeBond(bondRow) : null,
        event,
        note: 'Data ini belum menjadi nota selesai. Statusnya listed.',
      },
      201,
    );
  });

  app.get('/listings', (c) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const status = c.req.query('status');
    const vin = c.req.query('vin');
    const sellerId = c.req.query('sellerId');
    const corridorId = c.req.query('corridorId');
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (vin) {
      clauses.push('vin = ?');
      params.push(vin.toUpperCase());
    }
    if (sellerId) {
      clauses.push('seller_id = ?');
      params.push(sellerId);
    }
    if (corridorId) {
      clauses.push('corridor_id = ?');
      params.push(corridorId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = all(ctx.db, `SELECT * FROM listings ${where} ORDER BY created_at DESC LIMIT 200`, params);
    return c.json({ listings: rows.map(serializeListing), corridor: PILOT_CORRIDOR, candidateCorridors: CANDIDATE_CORRIDORS });
  });

  app.get('/listings/:id', (c) => {
    const row = get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [c.req.param('id')]);
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing tidak ditemukan' } }, 404);
    const seller = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [row.seller_id]);
    return c.json({
      listing: serializeListing(row),
      seller: seller ? serializeActor(seller) : null,
      vinNotice: vinScopeNotice(),
    });
  });

  /**
   * Listing hanya bisa diubah SEBELUM ada pembeli. Setiap perubahan dicatat
   * sebagai event baru - event lama tidak ditimpa.
   */
  app.patch('/listings/:id', async (c) => {
    const listingId = c.req.param('id');
    const listing = get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [listingId]);
    if (!listing) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing tidak ditemukan' } }, 404);
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    if (!callerId || callerId !== String(listing.seller_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya penjual yang boleh mengubah listingnya' } }, 403);
    }
    if (String(listing.status) !== 'listed') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Listing sudah ada pembeli atau sudah selesai. Perubahan tidak diizinkan.' } }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      priceAmount: string;
      shippingTerms: string;
      location: string;
      odometerKm: number;
      photoHashes: string[];
    }>;
    const updatedAt = nowIso();
    const fields: string[] = [];
    const params: unknown[] = [];
    if (body.priceAmount !== undefined) {
      fields.push('price_amount = ?');
      params.push(body.priceAmount);
    }
    if (body.shippingTerms !== undefined) {
      fields.push('shipping_terms = ?');
      params.push(body.shippingTerms);
    }
    if (body.location !== undefined) {
      fields.push('location = ?');
      params.push(body.location);
    }
    if (body.odometerKm !== undefined) {
      fields.push('odometer_km = ?');
      params.push(body.odometerKm);
    }
    if (body.photoHashes !== undefined) {
      fields.push('photo_hashes = ?');
      params.push(JSON.stringify(body.photoHashes));
    }
    if (fields.length === 0) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Tidak ada field yang diubah' } }, 400);
    }
    fields.push('updated_at = ?');
    params.push(updatedAt);
    params.push(listingId);
    run(ctx.db, `UPDATE listings SET ${fields.join(', ')} WHERE id = ?`, params);

    const event = appendEvent(ctx.db, {
      vin: String(listing.vin),
      type: 'listing_updated',
      dealId: null,
      payload: body as EventPayload,
      actorId: callerId,
      actorRole: 'seller',
    });
    return c.json({ listing: serializeListing(get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [listingId])!), event });
  });

  /**
   * Halaman kendaraan: rangkaian event per VIN + laporan + nota.
   * Wajib menampilkan batas hukum: ini jejak klaim dan transaksi, bukan title.
   */
  app.get('/vin/:vin', (c) => {
    const vin = c.req.param('vin').toUpperCase();
    const listings = all(ctx.db, 'SELECT * FROM listings WHERE vin = ? ORDER BY created_at DESC', [vin]).map(serializeListing);
    const reports = all(ctx.db, 'SELECT * FROM inspection_reports WHERE vin = ? ORDER BY created_at DESC', [vin]).map(serializeReport);
    const notes = all(ctx.db, 'SELECT * FROM notes WHERE vin = ? ORDER BY created_at DESC', [vin]).map(serializeNote);
    const events = eventsForVin(ctx.db, vin);
    const anomalies = events.filter((e) => e.type === 'odometer_anomaly');
    const lastOdometer = latestOdometer(ctx.db, vin);
    return c.json({
      vin,
      notice: vinScopeNotice(),
      listings,
      reports,
      notes,
      events,
      anomalies,
      lastOdometer,
      claimsBoundary:
        'Catatan ini adalah jejak klaim dan transaksi, bukan title/BPKB. Kepemilikan hukum tetap pada dokumen resmi negara asal dan tujuan.',
      ifNoData: events.length === 0 ? 'Belum ada riwayat di platform untuk VIN ini.' : null,
    });
  });

  return app;
}
