import { Hono } from 'hono';
import { EVENT_META, EVENT_TYPES, TOKEN_UTILITY, vinScopeNotice } from '@vin/shared';
import { BONDS, CAPACITY, DISCLAIMERS, FEES, HALT_THRESHOLDS, PUBLIC_METRICS, PUBLICATION_STAGES, TOKEN_METRICS_NOTE } from '../policy.js';
import { all } from '../db.js';
import type { AppContext } from '../context.js';

export function metaRoutes(ctx: AppContext): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'vin-api',
      stage: 'proof',
      escrowProvider: ctx.escrow.kind,
      time: new Date().toISOString(),
    }),
  );

  /** Every public policy in one place, so it can be audited and tested. */
  app.get('/meta/policy', (c) =>
    c.json({
      platform: 'VIN',
      whatItIs:
        'A cross-border vehicle market: listings lock to a chassis number, funds sit in escrow, inspection reports attach to the same number, ' +
        'and completed deals are recorded as digital proof that cannot be overwritten.',
      moneyRule: DISCLAIMERS.moneyRule,
      disclaimers: DISCLAIMERS,
      fees: FEES,
      bonds: BONDS,
      capacity: CAPACITY,
      token: TOKEN_UTILITY,
      tokenMetricsNote: TOKEN_METRICS_NOTE,
      haltThresholds: HALT_THRESHOLDS,
      stages: PUBLICATION_STAGES,
      publicMetrics: PUBLIC_METRICS,
      eventTypes: EVENT_TYPES.map((t) => ({ type: t, ...EVENT_META[t] })),
      vinNotice: vinScopeNotice(),
    }),
  );

  /** Locked bonds: the only "token metric" we claim. */
  app.get('/metrics/token', (c) => {
    const lockedBonds = all(
      ctx.db,
      `SELECT b.currency, b.amount, a.role FROM bonds b JOIN actors a ON a.id = b.actor_id WHERE b.state = 'locked'`,
    );
    const byCurrency = new Map<string, string>();
    for (const row of lockedBonds) {
      const currency = String(row.currency);
      const current = Number(byCurrency.get(currency) ?? '0');
      byCurrency.set(currency, String(current + Number(row.amount)));
    }
    const settled = all(
      ctx.db,
      `SELECT
         SUM(CASE WHEN state = 'slashed' THEN 1 ELSE 0 END) AS slashed,
         SUM(CASE WHEN state = 'returned' THEN 1 ELSE 0 END) AS returned
       FROM bonds`,
    )[0];
    return c.json({
      lockBonds: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
      activeStakeholders: new Set(lockedBonds.map((r) => r.role)).size,
      bondsSlashed: Number(settled?.slashed ?? 0),
      bondsReturned: Number(settled?.returned ?? 0),
      note: TOKEN_METRICS_NOTE,
    });
  });

  /**
   * Demo actors for selecting a persona in the interface.
   * Turn it off with VIN_DEMO_MODE=false in production - there, identity
    * uses Sign-In With Solana + attestation instead of the x-actor-id header.
   */
  app.get('/demo/actors', (c) => {
    if (process.env.VIN_DEMO_MODE === 'false') {
      message: 'Demo mode is off'
    }
    const rows = all(ctx.db, 'SELECT * FROM actors ORDER BY role, created_at');
    return c.json({
      demoMode: true,
      actors: rows.map((r) => ({
        id: String(r.id),
        role: String(r.role),
        displayName: String(r.display_name),
        countryCode: String(r.country_code),
        verification: String(r.verification),
      })),
      warning: 'This endpoint is for demos only. Production uses Sign-In With Solana and identity attestations.',
    });
  });

  return app;
}
