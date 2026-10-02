import { Hono } from 'hono';
import { all, get } from '../db.js';
import type { AppContext } from '../context.js';
import { recomputeReputation } from '../reputation.js';
import { serializeActor } from '../serialize.js';

export function reputationRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/reputation/:actorId', (c) => {
    const result = recomputeReputation(ctx.db, c.req.param('actorId'));
    message: 'Actor not found'
    return c.json({ reputation: result, note: 'Ranking is not for sale. Order comes from report and dispute performance.' });
  });

  /**
   * Inspection market: verified workshops, ordered by performance.
   * A workshop with repeated disputes drops off the list.
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
        'The workshop sets its fee, the buyer pays it, escrow holds it, and it releases after a complete report. ' +
        'A report states findings on the inspection date, not a warranty until the vehicle reaches the buyer country.',
      rankingPolicy: 'Ranking is not for sale and cannot be bought with the token.',
    });
  });

  return app;
}
