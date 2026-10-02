import { Hono } from 'hono';
import { all, get } from '../db.js';
import type { AppContext } from '../context.js';
import { recomputeReputation } from '../reputation.js';
import { serializeActor } from '../serialize.js';

export function reputationRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/reputation/:actorId', (c) => {
    const result = recomputeReputation(ctx.db, c.req.param('actorId'));
    if (!result) return c.json({ error: { code: 'NOT_FOUND', message: 'Aktor tidak ditemukan' } }, 404);
    return c.json({ reputation: result, note: 'Ranking tidak dijual. Urutan berasal dari kinerja laporan dan sengketa.' });
  });

  /**
   * Pasar inspeksi: bengkel terverifikasi, diurutkan dari kinerja.
   * Bengkel dengan sengketa berulang keluar dari daftar.
   */
  app.get('/inspectors', (c) => {
    const country = c.req.query('country');
    const clauses = [`role = 'inspector'`, `verification = 'business_verified'`];
    const params: unknown[] = [];
    if (country) {
      clauses.push('country_code = ?');
      params.push(country.toUpperCase());
    }
    const inspectors = all(ctx.db, `SELECT * FROM actors WHERE ${clauses.join(' AND ')}`, params);
    const ranked = inspectors
      .map((row) => {
        const actorId = String(row.id);
        const reputation = recomputeReputation(ctx.db, actorId);
        const bond = get(
          ctx.db,
          `SELECT COALESCE(SUM(CAST(amount AS REAL)),0) AS total, MIN(currency) AS currency FROM bonds
           WHERE actor_id = ? AND purpose = 'inspection_capacity' AND state = 'locked'`,
          [actorId],
        );
        return {
          actor: serializeActor(row),
          bond: { amount: String(bond?.total ?? 0), currency: String(bond?.currency ?? 'USDC') },
          reputation,
          score:
            (reputation?.onTimeReportRate ?? 0) * 0.5 +
            (reputation?.standardComplianceRate ?? 0) * 0.3 -
            (reputation?.disputesLost ?? 0) * 0.2,
        };
      })
      .filter((entry) => entry.reputation?.listedInRanking !== false)
      .sort((a, b) => b.score - a.score);
    return c.json({
      inspectors: ranked,
      note:
        'Biaya inspeksi ditentukan bengkel, dibayar pembeli, ditahan escrow, dan dilepas setelah laporan lengkap. ' +
        'Laporan adalah temuan pada tanggal inspeksi, bukan garansi sampai kendaraan tiba di negara pembeli.',
      rankingPolicy: 'Ranking tidak dijual, tidak bisa dibeli dengan token.',
    });
  });

  return app;
}
