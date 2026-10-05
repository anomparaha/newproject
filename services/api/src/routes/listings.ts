import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { zCreateListing, vinScopeNotice, type EventPayload } from '@vin/shared';
import { all, get, json, newId, nowIso, run } from '../db.js';
import { actorIdFromRequest, type AppContext } from '../context.js';
import { appendEvent, eventsForVin, latestOdometer, maxOdometer } from '../events.js';
import { serializeActor, serializeBond, serializeListing, serializeNote, serializeReport } from '../serialize.js';
import { BONDS, CANDIDATE_CORRIDORS, PILOT_CORRIDOR } from '../policy.js';

/** A simple rate for corridor value thresholds. Production: a licensed rate source plus audit. */
const USD_RATES: Record<string, number> = { USD: 1, USDC: 1, AED: 1 / 3.6725 };

export function listingRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/listings', zValidator('json', zCreateListing), (c) => {
    const input = c.req.valid('json');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const seller = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [input.sellerId]);
    if (!seller) return c.json({ error: { code: 'NOT_FOUND', message: 'Seller not found' } }, 404);
    if (seller.role !== 'seller') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a seller/dealer account may create a listing' } }, 403);
    }
    if (!callerId || callerId !== input.sellerId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the account owner may create a listing in their own name' } }, 403);
    }

    const rate = USD_RATES[input.priceCurrency];
    if (!rate) return c.json({ error: { code: 'FORBIDDEN', message: `Currency ${input.priceCurrency} is not supported yet` } }, 400);
    const priceUsd = Number(input.priceAmount) * rate;
    const corridor = PILOT_CORRIDOR;
    if (!corridor) {
      return c.json({ error: { code: 'CORRIDOR_NOT_SERVED', message: 'This corridor is not served yet' } }, 403);
    }
    const aboveThreshold = priceUsd >= corridor.minVehiclePriceUsd;

    // Above the value threshold: the seller must be verified and lock a bond.
    if (aboveThreshold && seller.verification !== 'business_verified') {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: `A listing above USD ${corridor.minVehiclePriceUsd} requires business identity verification for the seller.`,
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
            message: `A listing above the value threshold must lock a bond (e.g. ${BONDS.listingBondUsdc} USDC) before going live.`,
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

    // Re-listing a VIN below its highest recorded reading is allowed, but it is
    // never silent: the warning joins the VIN chain and the buyer has to
    // acknowledge it before any funds move.
    const highest = maxOdometer(ctx.db, input.vin);
    const odometerWarning =
      typeof input.odometerKm === 'number' && highest && input.odometerKm < highest.km
        ? appendEvent(ctx.db, {
            vin: input.vin,
            type: 'odometer_anomaly',
            dealId: null,
            payload: {
              odometerKm: input.odometerKm,
              anomaly: {
                previousOdometerKm: highest.km,
                previousEventId: highest.eventId,
                deltaKm: input.odometerKm - highest.km,
              },
            },
            actorId: input.sellerId,
            actorRole: 'seller',
          })
        : null;

    return c.json(
      {
        listing: serializeListing(get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [id])!),
        bond: bondRow ? serializeBond(bondRow) : null,
        event,
        odometerWarning: odometerWarning
          ? {
              flagged: true,
              message:
                'This listing reads below the highest odometer record on this VIN. It is a warning, not a rejection, and the buyer must see it before funds release.',
              previousOdometerKm: highest ? highest.km : null,
            }
          : { flagged: false },
        warningEvent: odometerWarning,
        note: 'This is not a completion receipt yet. Its status is listed.',
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
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } }, 404);
    const seller = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [row.seller_id]);
    return c.json({
      listing: serializeListing(row),
      seller: seller ? serializeActor(seller) : null,
      vinNotice: vinScopeNotice(),
    });
  });

  /**
   * A listing can only change BEFORE a buyer commits. Every change is recorded as
   * a new event - old events are never overwritten.
   */
  app.patch('/listings/:id', async (c) => {
    const listingId = c.req.param('id');
    const listing = get(ctx.db, 'SELECT * FROM listings WHERE id = ?', [listingId]);
    if (!listing) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } }, 404);
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    if (!callerId || callerId !== String(listing.seller_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the seller may change their listing' } }, 403);
    }
    if (String(listing.status) !== 'listed') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: 'This listing already has a buyer or has completed. Changes are not allowed.' } }, 409);
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
      return c.json({ error: { code: 'NOT_FOUND', message: 'No field was changed' } }, 400);
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
   * Vehicle page: the event chain per VIN plus reports and receipts.
   * It must state the legal boundary: a claim and transaction trail, not a title.
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
        'This record is a claim and transaction trail, not a title. Legal ownership stays with the official documents of the origin and destination countries.',
      ifNoData: events.length === 0 ? 'No history on the platform for this VIN yet.' : null,
    });
  });

  return app;
}
