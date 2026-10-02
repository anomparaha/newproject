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
    // Verifikasi: pembeli cukup dasar; penjual/bengkel butuh identitas usaha.
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
    return c.json({ actor: serializeActor(row), note: 'Verifikasi identitas usaha diperlukan sebelum beroperasi di atas ambang nilai tertentu.' }, 201);
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
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Aktor tidak ditemukan' } }, 404);
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
   * Jaminan bengkel (dan dealer) dikunci dalam stablecoin dulu pada Tahap Bukti.
   * Jaminan kembali bila deal bersih; terpotong bila pelanggaran.
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
    if (!actor) return c.json({ error: { code: 'NOT_FOUND', message: 'Aktor tidak ditemukan' } }, 404);

    const purpose = body.purpose ?? (actor.role === 'inspector' ? 'inspection_capacity' : 'listing');
    const amount = body.amount ?? BONDS.inspectorBondUsdc;
    const currency = body.currency ?? 'USDC';
    if (Number(amount) <= 0) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Jumlah jaminan harus positif' } }, 400);
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
          'Jaminan hanya untuk kelayakan dan kapasitas. Token tidak membeli harga kendaraan dan tidak memberi bagi hasil.',
      },
      201,
    );
  });

  /**
   * Verifikasi identitas usaha oleh kurator koridor.
   * Di produksi, langkah ini menghasilkan attestation yang bisa diverifikasi
   * (mis. Solana Attestation Service), bukan kolom basis data biasa.
   */
  app.post('/actors/:id/verify', async (c) => {
    const actorId = c.req.param('id');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const caller = callerId ? get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [callerId]) : undefined;
    if (!caller || caller.role !== 'curator') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya kurator koridor yang boleh memverifikasi identitas usaha' } }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { level?: string; note?: string };
    const level = body.level ?? 'business_verified';
    if (!['basic', 'business_verified', 'suspended'].includes(level)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Level verifikasi tidak dikenal' } }, 400);
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
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Aktor tidak ditemukan' } }, 404);
    return c.json({
      actor: serializeActor(row),
      note: 'Identitas bisa dicabut (suspend) bila ada pelanggaran. Penjual dan bengkel yang dicabut keluar dari pasar.',
    });
  });

  /**
   * Afiliasi penjual-bengkel. Bengkel yang terafiliasi dengan penjual DIBLOKIR
   * dari order unit penjual tersebut (konsep §2).
   */
  app.post('/actors/:id/affiliations', async (c) => {
    const actorId = c.req.param('id');
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const caller = callerId ? get(ctx.db, 'SELECT * FROM actors WHERE id = ?', [callerId]) : undefined;
    if (!caller || (caller.role !== 'curator' && caller.id !== actorId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya kurator koridor yang boleh mencatat afiliasi' } }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { relatedActorId?: string; note?: string };
    if (!body.relatedActorId) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'relatedActorId wajib' } }, 400);
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
    return c.json({ ok: true, note: 'Afiliasi tercatat. Bengkel terafiliasi diblokir dari order penjual tersebut.' }, 201);
  });

  /** Daftar afiliasi dipakai saat validasi pemilihan bengkel. */
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
