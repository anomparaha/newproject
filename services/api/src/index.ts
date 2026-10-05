import { serve } from '@hono/node-server';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const hostname = process.env.HOST ?? '0.0.0.0';

const db = openDb();
const app = createApp(db);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[vin-api] listening on http://${hostname}:${info.port}`);
  console.log('[vin-api] policy: GET /api/meta/policy');
  console.log('[vin-api] escrow: mock (stablecoin simulated) - the Solana program is not deployed yet');
  if (process.env.VIN_DEMO_MODE === 'false') {
    console.log('[vin-api] auth: sessions only (x-actor-id header rejected)');
  } else {
    console.log('[vin-api] auth: DEMO - x-actor-id header accepted; set VIN_DEMO_MODE=false to require a signed session');
  }
});

const shutdown = () => {
  try {
    db.close();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
