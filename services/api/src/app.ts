import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import type { DatabaseSync } from 'node:sqlite';
import { MoneyError } from '@vin/shared';
import { MockEscrowProvider } from './escrow.js';
import type { AppContext } from './context.js';
import { metaRoutes } from './routes/meta.js';
import { authRoutes } from './routes/auth.js';
import { actorRoutes } from './routes/actors.js';
import { corridorRoutes } from './routes/corridors.js';
import { listingRoutes } from './routes/listings.js';
import { dealRoutes } from './routes/deals.js';
import { reputationRoutes } from './routes/reputation.js';

export function createApp(db: DatabaseSync): Hono {
  const ctx: AppContext = { db, escrow: new MockEscrowProvider(db) };
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: (origin) => origin ?? '*',
      allowHeaders: ['Content-Type', 'x-actor-id', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    }),
  );

  const api = new Hono();
  api.route('/', metaRoutes(ctx));
  api.route('/', authRoutes(ctx));
  api.route('/', actorRoutes(ctx));
  api.route('/', corridorRoutes(ctx));
  api.route('/', listingRoutes(ctx));
  api.route('/', dealRoutes(ctx));
  api.route('/', reputationRoutes(ctx));
  app.route('/api', api);

  app.get('/', (c) =>
    c.json({
      name: 'VIN API',
      docs: '/api/meta/policy',
      note: 'Vehicle money never travels through a volatile token. The NFT is a receipt and a claim trail. The token is collateral and access.',
    }),
  );

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `No route ${c.req.method} ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'FORBIDDEN', message: err.message } }, err.status);
    }
    if (err instanceof MoneyError) {
      return c.json({ error: { code: 'FORBIDDEN', message: err.message } }, 400);
    }
    console.error('[vin-api] error:', err);
    return c.json({ error: { code: 'INTERNAL', message: err.message } }, 500);
  });

  return app;
}
