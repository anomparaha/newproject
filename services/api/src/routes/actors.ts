import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { zRegisterActor } from '@vin/shared';
import { BONDS } from '../policy.js';
import { all, get, json, newId, nowIso, run } from '../db.js';
import { actorIdFromRequest, type AppContext } from '../context.js';
import { serializeActor, serializeBond } from '../serialize.js';

export function actorRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.post('/actors', zValidator('json', zRegisterActor), (c) => {
    const input = c.req.valid('json');
    const id = newId(input.role === 'inspector' ? 'insp' : 'act');
    const createdAt = nowIso();
    // Verification: buyers need only the basic level; sellers/workshops need a business identity.
    const verification = input.role === 'buyer' ? 'basic' : 'none';
    run(
      ctx.db,
      `INSERT INTO actors (id, role, display_name, email, wallet_address, payout_address, verification, country_code, city, base_currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.role,
        input.displayName,
        input.email,
        input.walletAddress ?? null,
        input.payoutAddress ?? input.walletAddress ?? null,
        verification,
        input.countryCode,
        input.city ?? null,
        'USDC',
        createdAt,
      ],
    );
    run(ctx.db, 'INSERT INTO reputation (actor_id, role, last_computed_at) VALUES (?, ?, ?)', [id, input.role, createdAt]);
    const row = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [id])!;
    return c.json({ actor: serializeActor(row), note: 'Business identity verification is required before operating above a value threshold.' }, 201);
  });

  app.get('/actors', (c) => {
    const role = c.req.query('role');
    const country = c.req.query('country');
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (role) {
      clauses.push('role = ?');
      params.push(role);
    }
    if (country) {
      clauses.push('country_code = ?');
      params.push(country.toUpperCase());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = all(ctx.db, `SELECT * FROM actors ${where} ORDER BY created_at DESC`, params);
    return c.json({ actors: rows.map(serializeActor) });
  });

  app.get('/actors/:id', (c) => {
    const row = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [c.req.param('id')]);
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Actor not found' } }, 404);
    const bonds = all(ctx.db, 'SELECT * FROM bonds WHERE actor_id = ? ORDER BY locked_at DESC', [row.id]);
    const reputation = get(ctx.db, 'SELECT * FROM reputation WHERE actor_id = ?', [row.id]);
    return c.json({
      actor: serializeActor(row),
      bonds: bonds.map(serializeBond),
      reputation: reputation
        ? {
            dealsCompleted: Number(reputation.deals_completed),
            disputesOpened: Number(reputation.disputes_opened),
            disputesLost: Number(reputation.disputes_lost),
            onTimeReportRate: reputation.on_time_report_rate === null ? null : Number(reputation.on_time_report_rate),
            standardComplianceRate:
              reputation.standard_compliance_rate === null ? null : Number(reputation.standard_compliance_rate),
            medianReportHours: reputation.median_report_hours === null ? null : Number(reputation.median_report_hours),
            listedInRanking: Number(reputation.listed_in_ranking) === 1,
          }
        : null,
    });
  });

  /**
   * Workshop (and dealer) bonds are locked in stablecoin during the Proof Stage.
   * The bond returns after a clean deal and is slashed on a violation.
   */
  app.post('/actors/:id/bonds', async (c) => {
    const actorId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      amount?: string;
      currency?: 'VIN' | 'USDC';
      purpose?: 'listing' | 'inspection_capacity';
      listingId?: string;
    };
    const actor = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [actorId]);
    if (!actor) return c.json({ error: { code: 'NOT_FOUND', message: 'Actor not found' } }, 404);

    const purpose = body.purpose ?? (actor.role === 'inspector' ? 'inspection_capacity' : 'listing');
    const amount = body.amount ?? BONDS.inspectorBondUsdc;
    const currency = body.currency ?? 'USDC';
    if (Number(amount) <= 0) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'The bond amount must be positive' } }, 400);
    }

    const id = newId('bond');
    const lockedAt = nowIso();
    run(
      ctx.db,
      `INSERT INTO bonds (id, actor_id, purpose, amount, currency, state, listing_id, reason, locked_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 'locked', ?, NULL, ?, NULL)`,
      [id, actorId, purpose, amount, currency, body.listingId ?? null, lockedAt],
    );
    if (purpose === 'inspection_capacity') {
      run(ctx.db, 'UPDATE actors SET verification = ? WHERE id = ? AND verification = ?', ['business_verified', actorId, 'none']);
    }
    const row = get(ctx.db, 'SELECT * FROM bonds WHERE id = ?', [id])!;
    return c.json(
      {
        bond: serializeBond(row),
        note:
          'Bonds are for eligibility and capacity only. The token never buys a vehicle price and pays no revenue share.',
      },
      201,
    );
  });

  /**
   * Business identity verification by the corridor curator.
   * In production this step produces a verifiable attestation
    * (e.g. the Solana Attestation Service), not a plain database column.
   */
  app.post('/actors/:id/verify', async (c) => {
    const actorId = c.req.param('id');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const caller = callerId ? get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [callerId]) : undefined;
    if (!caller || caller.role !== 'curator') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a corridor curator may verify business identities' } }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { level?: string; note?: string };
    const level = body.level ?? 'business_verified';
    if (!['basic', 'business_verified', 'suspended'].includes(level)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Unknown verification level' } }, 400);
    }
    run(ctx.db, 'UPDATE actors SET verification = ? WHERE id = ?', [level, actorId]);
    run(ctx.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'actor_verified',
      callerId,
      'actor',
      actorId,
      JSON.stringify({ level, note: body.note ?? null }),
      nowIso(),
    ]);
    const row = get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [actorId]);
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Actor not found' } }, 404);
    return c.json({
      actor: serializeActor(row),
      note: 'An identity can be revoked (suspended) after a violation. Revoked sellers and workshops leave the market.',
    });
  });

  /**
   * Seller-workshop affiliation. A workshop affiliated with a seller is BLOCKED
   * from that unit orders from that seller (concept §2).
   */
  app.post('/actors/:id/affiliations', async (c) => {
    const actorId = c.req.param('id');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const caller = callerId ? get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [callerId]) : undefined;
    if (!caller || (caller.role !== 'curator' && caller.id !== actorId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a corridor curator may record affiliations' } }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { relatedActorId?: string; note?: string };
    if (!body.relatedActorId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'relatedActorId is required' } }, 400);
    }
    run(ctx.db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'affiliation_registered',
      caller.id,
      'actor',
      actorId,
      JSON.stringify({ relatedActorId: body.relatedActorId, note: body.note ?? null }),
      nowIso(),
    ]);
    return c.json({ ok: true, note: 'Affiliation recorded. The affiliated workshop is blocked from that orders from that seller.' }, 201);
  });

  /** The affiliation list is used when validating a workshop choice. */
  app.get('/actors/:id/affiliations', (c) => {
    const rows = all(
      ctx.db,
      `SELECT * FROM audit_log WHERE action = 'affiliation_registered' AND entity_id = ? ORDER BY created_at DESC`,
      [c.req.param('id')],
    );
    return c.json({
      affiliations: rows.map((r) => ({
        actorId: String(r.entity_id),
        relatedActorId: String(json<{ relatedActorId: string }>(r.detail as string, { relatedActorId: '' }).relatedActorId),
        recordedBy: r.actor_id === null ? null : String(r.actor_id),
        at: String(r.created_at),
      })),
    });
  });

  return app;
}
