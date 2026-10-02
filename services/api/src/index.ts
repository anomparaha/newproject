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
