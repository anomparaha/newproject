import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { zCreateCorridor, type CorridorMetrics } from '@vin/shared';
import { all, get, json, newId, nowIso, run } from '../db.js';
import { actorIdFromRequest, type AppContext } from '../context.js';
import { CANDIDATE_CORRIDORS, PILOT_CORRIDOR, evaluateCorridorHealth } from '../policy.js';

/** A second corridor does not open before the first one genuinely works. */
const MIN_DEALS_BEFORE_EXPANSION = 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function corridorRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;

  app.get('/corridors', (c) => {
    const rows = all(db, 'SELECT * FROM corridors ORDER BY opened_at DESC');
    const corridors = rows.map((row) => ({
      id: String(row.id),
      originCountry: String(row.origin_country),
      destinationCountry: String(row.destination_country),
      minVehiclePriceUsd: Number(row.min_vehicle_price_usd),
      mandatoryInspection: true,
      allowedCurrencies: json<string[]>(row.allowed_currencies as string, []),
      status: String(row.status) as 'pilot' | 'active' | 'paused',
      openedAt: String(row.opened_at),
    }));
    return c.json({ corridors, candidateCorridors: CANDIDATE_CORRIDORS });
  });

  /** Only a curator may open a corridor, and only when the existing one is healthy. */
  app.post('/corridors', zValidator('json', zCreateCorridor), (c) => {
    const callerId = actorIdFromRequest(c.req.header('x-actor-id'));
    const caller = callerId ? get(db, 'SELECT * FROM actors WHERE id = ?', [callerId]) : undefined;
    if (!caller || caller.role !== 'curator') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a corridor curator may open a new corridor' } }, 403);
    }
    const input = c.req.valid('json');
    const existing = all(db, 'SELECT id FROM corridors');
    if (existing.length > 0) {
      const health = computeMetrics(db, String(existing[0]!.id));
      const metrics = health?.metrics ?? null;
      const bolehMembuka =
        metrics !== null && !metrics.expansionHalted && metrics.dealsCompleted >= MIN_DEALS_BEFORE_EXPANSION;
      if (!bolehMembuka) {
        return c.json(
          {
            error: {
              code: 'FORBIDDEN',
              message:
                'A new corridor opens only after the completed-deal rate and the dispute rate in the existing one are under control.',
              details: {
                currentCorridorMetrics: metrics,
                required: { minDealsCompleted: MIN_DEALS_BEFORE_EXPANSION, expansionNotHalted: true },
              },
            },
          },
          409,
        );
      }
    }
    const id = newId('cor');
    const openedAt = nowIso();
    run(
      db,
      `INSERT INTO corridors (id, origin_country, destination_country, min_vehicle_price_usd, allowed_currencies, status, opened_at)
       VALUES (?, ?, ?, ?, ?, 'pilot', ?)`,
      [
        id,
        input.originCountry,
        input.destinationCountry,
        input.minVehiclePriceUsd,
        JSON.stringify(input.allowedCurrencies),
        openedAt,
      ],
    );
    const row = get(db, 'SELECT * FROM corridors WHERE id = ?', [id])!;
    return c.json({ corridor: row }, 201);
  });

  /**
   * Public metrics: completed deals, median time to report, dispute rate.
   * Plus empat angka pemicu berhenti perluasan.
   */
  app.get('/corridors/:id/metrics', (c) => {
    const corridorId = c.req.param('id');
    const result = computeMetrics(db, corridorId);
    if (!result) return c.json({ error: { code: 'NOT_FOUND', message: 'Corridor not found' } }, 404);
    return c.json(result);
  });

  return app;
}

function computeMetrics(db: AppContext['db'], corridorId: string): { metrics: CorridorMetrics; halt: { halted: boolean; reasons: string[] } } | null {
  const corridor = get(db, 'SELECT * FROM corridors WHERE id = ?', [corridorId]);
  if (!corridor) return null;

  const deals = all(
    db,
    `SELECT d.* FROM deals d JOIN listings l ON l.id = d.listing_id WHERE l.corridor_id = ?`,
    [corridorId],
  );
  const dealIds = deals.map((d) => String(d.id));
  const completed = deals.filter((d) => String(d.state) === 'completed').length;
  const disputes = dealIds.length > 0
    ? all(db, `SELECT * FROM disputes WHERE deal_id IN (${dealIds.map(() => '?').join(',')})`, dealIds)
    : [];
  const disputeRate = deals.length > 0 ? disputes.length / deals.length : 0;

  // Median time from locking a deal to uploading a report.
  const durations: number[] = [];
  for (const dealId of dealIds) {
    const rows = all(
      db,
      `SELECT type, created_at FROM events WHERE deal_id = ? AND type IN ('deal_committed','report_uploaded') ORDER BY seq ASC`,
      [dealId],
    );
    const committed = rows.find((r) => String(r.type) === 'deal_committed');
    const reported = rows.find((r) => String(r.type) === 'report_uploaded');
    if (committed && reported) {
      durations.push((Date.parse(String(reported.created_at)) - Date.parse(String(committed.created_at))) / 3_600_000);
    }
  }

  // Unexplained odometer anomalies: anomalies on VINs in this corridor whose
  // VIN never completed a dispute.
  const vins = [...new Set(deals.map((d) => String(d.vin)))];
  let unexplained = 0;
  for (const vin of vins) {
    const anomalyCount = all(db, `SELECT id FROM events WHERE vin = ? AND type = 'odometer_anomaly'`, [vin]).length;
    if (anomalyCount === 0) continue;
    const resolved = all(db, `SELECT id FROM events WHERE vin = ? AND type = 'dispute_resolved'`, [vin]).length;
    if (resolved === 0) unexplained += anomalyCount;
  }

  const sellers = [...new Set(deals.map((d) => String(d.seller_id)))];
  const inspectors = [...new Set(deals.map((d) => String(d.inspector_id)))];
  const repeatSellers = sellers.filter((s) => deals.filter((d) => String(d.seller_id) === s).length >= 2).length;
  const repeatInspectors = inspectors.filter((i) => deals.filter((d) => String(d.inspector_id) === i).length >= 2).length;

  const metrics: CorridorMetrics = {
    corridorId,
    dealsCompleted: completed,
    disputeRate: Number(disputeRate.toFixed(4)),
    medianHoursToReport: median(durations) === null ? null : Number(median(durations)!.toFixed(2)),
    unexplainedOdometerAnomalies: unexplained,
    sellerReturnRate: sellers.length > 0 ? Number((repeatSellers / sellers.length).toFixed(2)) : 0,
    inspectorReturnRate: inspectors.length > 0 ? Number((repeatInspectors / inspectors.length).toFixed(2)) : 0,
    expansionHalted: false,
    haltReasons: [],
  };
  const halt = evaluateCorridorHealth(metrics);
  metrics.expansionHalted = halt.halted;
  metrics.haltReasons = halt.reasons;
  return {
    metrics,
    halt,
  };
}

export const PILOT = PILOT_CORRIDOR;
