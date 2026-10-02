import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  type Escrow as EscrowDto,
  type EventPayload,
  type ReleaseTerms,
  bpsFee,
  defaultReleaseTerms,
  evidenceRoot,
  fromMinorUnits,
  odometerIsAnomaly,
  reportMeetsStandard,
  slashBond,
  toMinorUnits,
  vehicleReleasePreconditions,
  zCommitDeal,
  zConfirmHandover,
  zOpenDispute,
  zResolveDispute,
  zUploadReport,
} from '@vin/shared';
import { all, get, json, newId, nowIso, run } from '../db.js';
import { actorIdFromRequest, demoBackdate, type AppContext } from '../context.js';
import { appendEvent, eventsForDeal, eventsForVin, maxOdometer } from '../events.js';
import { serializeActor, serializeDeal, serializeDispute, serializeNote, serializeReport } from '../serialize.js';
import { FEES } from '../policy.js';

function affiliateIds(db: AppContext['db'], sellerId: string): string[] {
  const rows = all(
    db,
    `SELECT detail FROM audit_log WHERE action = 'affiliation_registered' AND entity_id = ?`,
    [sellerId],
  );
  return rows
    .map((r) => json<{ relatedActorId?: string }>(r.detail as string, {}).relatedActorId)
    .filter((v): v is string => typeof v === 'string');
}

function lockedBondTotal(db: AppContext['db'], actorId: string, purpose: string): number {
  const row = get(
    db,
    `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS total FROM bonds WHERE actor_id = ? AND purpose = ? AND state = 'locked'`,
    [actorId, purpose],
  );
  return Number(row?.total ?? 0);
}

/**
 * Settles the INSPECTION LEG when a dispute is resolved.
 *
 * The same rule as `resolve_dispute` in the Anchor program:
 *  - when the workshop already uploaded a report, the workshop is STILL paid
 *    for the work, after the platform fee;
 *  - when there is no report yet, the inspection funds return to the buyer.
 *
 * Without this step, inspection funds could be stranded or the workshop unpaid
 * when a dispute does not go the way of the seller.
 */
async function settleInspectionLeg(
  ctx: AppContext,
  deal: Record<string, unknown>,
  dealId: string,
  arbiterId: string,
): Promise<{ toInspector: string; toBuyer: string; currency: string }> {
  const currency = String(deal.inspection_fee_currency);
  const escrow = ctx.escrow.findById(String(deal.escrow_ref_inspection));
  // The escrow may be `frozen` because of a dispute; the arbiter ruling is the
  // only path allowed to move funds out of that state.
  if (!escrow || (escrow.status !== 'funded' && escrow.status !== 'frozen')) {
    return { toInspector: '0', toBuyer: '0', currency };
  }
  const report = get(ctx.db, 'SELECT id FROM inspection_reports WHERE deal_id = ? LIMIT 1', [dealId]);
  const evidence = eventsForDeal(ctx.db, dealId).map((e) => e.id);
  const amount = String(deal.inspection_fee_amount);

  if (report) {
    const fee = bpsFee(amount, FEES.inspectionBps, currency);
    const toInspector = fromMinorUnits(toMinorUnits(amount, currency) - toMinorUnits(fee, currency), currency);
    // The inspection leg is paid through arbitration because the escrow is frozen.
    await ctx.escrow.resolveByArbitration(escrow.id, {
      decision: 'refund_buyer',
      toBuyer: '0',
      toCounterparty: toInspector,
      evidenceEventIds: evidence,
    });
    run(
      ctx.db,
      'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
      [
        newId('aud'),
        'dispute_inspection_paid',
        arbiterId,
        'deal',
        dealId,
        JSON.stringify({ toInspector, platformFee: fee, reason: 'a report was uploaded before the dispute' }),
        nowIso(),
      ],
    );
    return { toInspector, toBuyer: '0', currency };
  }

  await ctx.escrow.resolveByArbitration(escrow.id, {
    decision: 'refund_buyer',
    toBuyer: amount,
    toCounterparty: '0',
    evidenceEventIds: evidence,
  });
  return { toInspector: '0', toBuyer: amount, currency };
}

export function dealRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;

  // -------------------------------------------------------------------------
  // The buyer locks the deal
  // -------------------------------------------------------------------------
  app.post('/listings/:id/deals', zValidator('json', zCommitDeal), async (c) => {
    const listingId = c.req.param('id');
    const input = c.req.valid('json');
    const listing = get(db, 'SELECT * FROM listings WHERE id = ?', [listingId]);
    if (!listing) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing not found' } }, 404);
    if (String(listing.status) !== 'listed') {
      return c.json(
        { error: { code: 'LISTING_ALREADY_RESERVED', message: 'This listing is already locked by another buyer or has completed.' } },
        409,
      );
    }

    const buyer = get(db, 'SELECT * FROM actors WHERE id = ?', [input.buyerId]);
    if (!buyer || buyer.role !== 'buyer') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a buyer account may lock a deal' } }, 403);
    }
    if (String(buyer.verification) === 'none') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'The buyer needs the basic verification level before paying' } }, 403);
    }

    const inspector = get(db, 'SELECT * FROM actors WHERE id = ?', [input.inspectorId]);
    if (!inspector || inspector.role !== 'inspector') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Inspection workshop not found' } }, 404);
    }
    if (String(inspector.verification) !== 'business_verified') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'The workshop has not passed identity checks yet' } }, 403);
    }
    if (lockedBondTotal(db, input.inspectorId, 'inspection_capacity') <= 0) {
      return c.json({ error: { code: 'BOND_REQUIRED', message: 'The workshop has not locked an inspection capacity bond' } }, 400);
    }
    // A seller may not appoint an inspector for their own unit; workshops
    // affiliated with the seller are blocked from that order.
    if (affiliateIds(db, String(listing.seller_id)).includes(input.inspectorId)) {
      return c.json(
        {
          error: {
            code: 'INSPECTOR_CONFLICT',
            message: 'This workshop is affiliated with the seller and blocked from that unit order.',
          },
        },
        403,
      );
    }

    const dealId = newId('deal');
    const createdAt = nowIso();
    const deadline = new Date(Date.now() + input.inspectionDeadlineHours * 3600_000).toISOString();
    const terms: ReleaseTerms = defaultReleaseTerms({ handoverTerms: input.handoverTerms });
    const vehicleAmount =
      input.shippingPaidBy === 'buyer'
        ? String(Number(listing.price_amount) + Number(input.shippingAmount))
        : String(listing.price_amount);

    // The deal row is written first (the escrow references deal_id), then the escrows,
    // then the references are updated. This order respects the foreign key.
    run(
      db,
      `INSERT INTO deals (id, listing_id, vin, buyer_id, seller_id, inspector_id, state, price_amount, price_currency,
        shipping_paid_by, shipping_amount, inspection_fee_amount, inspection_fee_currency,
        escrow_ref_vehicle, escrow_ref_inspection, inspection_released_at, vehicle_released_at,
        inspection_deadline, handover_terms, handover_confirmed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'escrow_pending', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', ?, ?)`,
      [
        dealId,
        listingId,
        String(listing.vin),
        input.buyerId,
        String(listing.seller_id),
        input.inspectorId,
        String(listing.price_amount),
        String(listing.price_currency),
        input.shippingPaidBy,
        input.shippingAmount,
        input.inspectionFeeAmount,
        input.escrowCurrency,
        deadline,
        input.handoverTerms,
        createdAt,
        createdAt,
      ],
    );

    // Two separate escrows: vehicle funds and inspection funds are never mixed.
    const vehicleEscrow = await ctx.escrow.createEscrow({
      dealId,
      leg: 'vehicle',
      amount: vehicleAmount,
      currency: String(listing.price_currency),
      releaseTerms: terms,
    });
    const inspectionEscrow = await ctx.escrow.createEscrow({
      dealId,
      leg: 'inspection',
      amount: input.inspectionFeeAmount,
      currency: input.escrowCurrency,
      releaseTerms: terms,
    });
    run(db, 'UPDATE deals SET escrow_ref_vehicle = ?, escrow_ref_inspection = ? WHERE id = ?', [
      vehicleEscrow.id,
      inspectionEscrow.id,
      dealId,
    ]);
    run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE id = ?', ['reserved', createdAt, listingId]);

    return c.json(
      {
        deal: serializeDeal(get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!),
        escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow),
        next: `The buyer funds the escrow: POST /api/deals/${dealId}/fund`,
        note:
          'The vehicle price and the inspection fee sit in SEPARATE escrows. ' +
          'Vehicle funds do not release before the handover terms are met.',
      },
      201,
    );
  });

  /**
   * Confirm escrow funding (production: a webhook from a licensed payment provider).
   * The `deal_committed` event is written AFTER the funds really enter escrow.
   */
  app.post('/deals/:id/fund', async (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    if (String(deal.state) !== 'escrow_pending') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `The deal is ${deal.state}; it cannot be funded again.` } }, 409);
    }
    const vehicle = ctx.escrow.findById(String(deal.escrow_ref_vehicle));
    const inspection = ctx.escrow.findById(String(deal.escrow_ref_inspection));
    if (!vehicle || !inspection) return c.json({ error: { code: 'NOT_FOUND', message: 'Escrow not found' } }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { payerRef?: string };
    const payerRef = body.payerRef ?? String(deal.buyer_id);
    // The simulated clock only applies in demo mode (see context.ts).
    const backdated = demoBackdate(c.req.header('x-demo-backdate-hours'), nowIso);
    const v = await ctx.escrow.fund(vehicle.id, payerRef);
    const i = await ctx.escrow.fund(inspection.id, payerRef);

    const payload: EventPayload = {
      dealId,
      buyerId: String(deal.buyer_id),
      selectedInspectorId: String(deal.inspector_id),
      inspectionFeeAmount: String(deal.inspection_fee_amount),
      inspectionFeeCurrency: String(deal.inspection_fee_currency),
      inspectionDeadline: String(deal.inspection_deadline),
      escrowRef: `${v.txRef}|${i.txRef}`,
      priceAmount: String(deal.price_amount),
      priceCurrency: String(deal.price_currency),
    };
    const event = appendEvent(db, {
      vin: String(deal.vin),
      type: 'deal_committed',
      dealId,
      payload,
      actorId: String(deal.buyer_id),
      actorRole: 'buyer',
      ...(backdated ? { createdAt: backdated } : {}),
    });
    const updatedAt = nowIso();
    run(db, 'UPDATE deals SET state = ?, updated_at = ? WHERE id = ?', ['inspecting', updatedAt, dealId]);
    if (backdated) {
      run(db, 'UPDATE deals SET created_at = ? WHERE id = ?', [backdated, dealId]);
    }

    return c.json({
      deal: serializeDeal(get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!),
      escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow),
      event,
      note: 'Deal locked. The same listing cannot be sold to a second buyer while the escrow is active.',
    });
  });

  // -------------------------------------------------------------------------
    // Inspection
  // -------------------------------------------------------------------------
  app.post('/deals/:id/reports', zValidator('json', zUploadReport), (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    if (String(deal.state) !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `A report cannot be uploaded while the deal is ${deal.state}` } }, 409);
    }
    if (String(deal.inspector_id) !== input.inspectorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the workshop chosen by the buyer may upload a report' } }, 403);
    }
    const standard = reportMeetsStandard(input.checklist as unknown as Record<string, boolean>);
    if (!standard.ok) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'The report does not meet the minimum standard yet.',
            details: { missing: standard.missing },
          },
        },
        400,
      );
    }

    const vin = String(deal.vin);
    // Baseline = the highest reading ever recorded on this VIN, never the latest
    // one. A low report must not reset the comparison point.
    const previous = maxOdometer(db, vin);
    const previousKm = previous ? previous.km : null;
    const anomaly = odometerIsAnomaly(input.odometerKm, previousKm);

    const reportId = newId('rpt');
    const createdAt = nowIso();
    // Demo clock: so workshop turnaround metrics make sense.
    const backdated = demoBackdate(c.req.header('x-demo-backdate-hours'), nowIso);
    run(
      db,
      `INSERT INTO inspection_reports (id, deal_id, vin, inspector_id, odometer_km, inspected_at, report_hash,
        dashboard_photo_hash, condition_summary, standard_version, checklist, anomaly, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reportId,
        dealId,
        vin,
        input.inspectorId,
        input.odometerKm,
        input.inspectedAt,
        input.reportHash,
        input.dashboardPhotoHash,
        input.conditionSummary,
        input.standardVersion,
        JSON.stringify(input.checklist),
        anomaly ? 1 : 0,
        createdAt,
      ],
    );

    const reportEvent = appendEvent(db, {
      vin,
      type: 'report_uploaded',
      dealId,
      payload: {
        inspectorId: input.inspectorId,
        odometerKm: input.odometerKm,
        inspectedAt: input.inspectedAt,
        reportHash: input.reportHash,
        dashboardPhotoHash: input.dashboardPhotoHash,
        reportStandardVersion: input.standardVersion,
      },
      actorId: input.inspectorId,
      actorRole: 'inspector',
      ...(backdated ? { createdAt: backdated } : {}),
    });

    let anomalyEvent = null;
    if (anomaly && previous && previousKm !== null) {
      anomalyEvent = appendEvent(db, {
        vin,
        type: 'odometer_anomaly',
        dealId,
        payload: {
          odometerKm: input.odometerKm,
          anomaly: {
            previousOdometerKm: previousKm,
            previousEventId: previous.eventId,
            deltaKm: input.odometerKm - previousKm,
          },
        },
        actorId: input.inspectorId,
        actorRole: 'inspector',
        ...(backdated ? { createdAt: backdated } : {}),
      });
    }

    return c.json(
      {
        report: serializeReport(get(db, 'SELECT * FROM inspection_reports WHERE id = ?', [reportId])!),
        events: [reportEvent, anomalyEvent].filter(Boolean),
        anomaly: anomaly
          ? {
              flagged: true,
              message:
                'An odometer anomaly is not an automatic rejection; it is a warning the buyer MUST see before funds release.',
              previousOdometerKm: previousKm,
            }
          : { flagged: false },
        offChainNote: 'Raw files stay off-chain. Only the hash is anchored.',
      },
      201,
    );
  });

  /** The buyer accepts the report -> inspection funds release to the workshop (after the fee). */
  app.post('/deals/:id/reports/:reportId/accept', async (c) => {
    const dealId = c.req.param('id');
    const reportId = c.req.param('reportId');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    if (String(deal.state) !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `No report is pending while the deal is ${deal.state}` } }, 409);
    }
    const report = get(db, 'SELECT * FROM inspection_reports WHERE id = ? AND deal_id = ?', [reportId, dealId]);
    if (!report) return c.json({ error: { code: 'NOT_FOUND', message: 'Report not found' } }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { buyerId?: string };
    const buyerId = body.buyerId ?? actorIdFromRequest(c.req.header('x-actor-id'));
    if (!buyerId || buyerId !== String(deal.buyer_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the buyer may accept the report' } }, 403);
    }
    // An odometer anomaly must be seen before funds release. This covers the
    // report for this deal AND warnings raised earlier on the same VIN (for
    // example a re-listing below the highest recorded reading).
    const anomalies = eventsForVin(db, String(deal.vin)).filter((e) => e.type === 'odometer_anomaly');
    const acknowledged = (body as { acknowledgeAnomaly?: boolean }).acknowledgeAnomaly === true;
    if (anomalies.length > 0 && !acknowledged) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'This VIN has an odometer anomaly. Confirm first that the warning was read.',
            details: { anomalies: anomalies.map((a) => a.payload.anomaly) },
          },
        },
        400,
      );
    }

    const escrow = ctx.escrow.findById(String(deal.escrow_ref_inspection));
    if (!escrow) return c.json({ error: { code: 'NOT_FOUND', message: 'Inspection escrow not found' } }, 404);
    const feeAmount = String(deal.inspection_fee_amount);
    const currency = String(deal.inspection_fee_currency);
    const platformFee = bpsFee(feeAmount, FEES.inspectionBps, currency);
    const reportEvent = eventsForDeal(db, dealId).find((e) => e.type === 'report_uploaded')!;

    const release = await ctx.escrow.release(escrow.id, {
      recipientRef: String(deal.inspector_id),
      evidenceEventIds: [reportEvent.id],
    });

    const event = appendEvent(db, {
      vin: String(deal.vin),
      type: 'inspection_funds_released',
      dealId,
      payload: {
        amount: feeAmount,
        currency,
        platformFeeAmount: platformFee,
        recipientId: String(deal.inspector_id),
        payoutRef: release.txRef,
      },
      actorId: buyerId,
      actorRole: 'buyer',
    });
    run(db, 'UPDATE deals SET state = ?, inspection_released_at = ?, updated_at = ? WHERE id = ?', [
      'inspection_accepted',
      release.releasedAt,
      nowIso(),
      dealId,
    ]);

    return c.json({
      deal: serializeDeal(get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!),
      event,
      payout: { toInspector: subtract(feeAmount, platformFee, currency), platformFee, currency, txRef: release.txRef },
      next: `Confirm handover: POST /api/deals/${dealId}/handover`,
    });
  });

  // -------------------------------------------------------------------------
  // Handover and vehicle fund release
  // -------------------------------------------------------------------------
  app.post('/deals/:id/handover', zValidator('json', zConfirmHandover), (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    const state = String(deal.state);
    if (state === 'frozen') {
      return c.json({ error: { code: 'DEAL_FROZEN', message: 'The deal is frozen. Handover cannot be confirmed until arbitration rules.' } }, 409);
    }
    if (state !== 'inspection_accepted' && state !== 'handover_pending' && state !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Handover confirmation does not apply while the deal is ${state}` } }, 409);
    }
    const actorId = input.actorId;
    const allowed = [String(deal.buyer_id), String(deal.seller_id)];
    if (!allowed.includes(actorId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the buyer or the seller may confirm handover' } }, 403);
    }

    const confirmed = json<string[]>(deal.handover_confirmed_by as string, []);
    if (!confirmed.includes(actorId)) confirmed.push(actorId);
    run(db, 'UPDATE deals SET handover_confirmed_by = ?, state = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(confirmed),
      'handover_pending',
      nowIso(),
      dealId,
    ]);
    run(db, 'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)', [
      newId('aud'),
      'handover_confirmed',
      actorId,
      'deal',
      dealId,
      JSON.stringify({ method: input.method, evidenceHash: input.evidenceHash ?? null }),
      nowIso(),
    ]);

    const updated = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!;
    const preconditions = vehicleReleasePreconditions({
      handoverTerms: String(updated.handover_terms),
      confirmedBy: confirmed,
      buyerId: String(updated.buyer_id),
      sellerId: String(updated.seller_id),
      disputeOpen: hasOpenDispute(db, dealId),
    });
    return c.json({
      deal: serializeDeal(updated),
      readyForRelease: preconditions.ok,
      missing: preconditions.missing,
      next: preconditions.ok ? `POST /api/deals/${dealId}/release-vehicle` : 'Waiting for the other party to confirm.',
    });
  });

  /**
   * Vehicle fund release: only after the handover terms locked at the start
   * are met. The completion receipt is recorded after the funds release.
   */
  app.post('/deals/:id/release-vehicle', async (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    if (String(deal.state) !== 'handover_pending') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `The deal is ${deal.state}; it is not ready for vehicle fund release.` } }, 409);
    }
    const disputeOpen = hasOpenDispute(db, dealId);
    const preconditions = vehicleReleasePreconditions({
      handoverTerms: String(deal.handover_terms),
      confirmedBy: json<string[]>(deal.handover_confirmed_by as string, []),
      buyerId: String(deal.buyer_id),
      sellerId: String(deal.seller_id),
      disputeOpen,
    });
    if (!preconditions.ok) {
      return c.json(
        {
          error: {
            code: 'INVALID_TRANSITION',
            message: 'The handover terms are not met yet. Vehicle funds must not release.',
            details: { missing: preconditions.missing },
          },
        },
        409,
      );
    }

    const escrow = ctx.escrow.findById(String(deal.escrow_ref_vehicle));
    if (!escrow) return c.json({ error: { code: 'NOT_FOUND', message: 'Vehicle escrow not found' } }, 404);
    const priceAmount = String(deal.price_amount);
    const currency = String(deal.price_currency);
    const platformFee = bpsFee(priceAmount, FEES.vehicleBps, currency);
    const shipping = String(deal.shipping_paid_by) === 'buyer' ? String(deal.shipping_amount) : '0';
    const payoutToSeller = subtract(add(priceAmount, shipping, currency), platformFee, currency);

    const events = eventsForDeal(db, dealId);
    const reportEventIds = events.filter((e) => e.type === 'report_uploaded').map((e) => e.id);
    const release = await ctx.escrow.release(escrow.id, {
      recipientRef: String(deal.seller_id),
      evidenceEventIds: reportEventIds.length > 0 ? reportEventIds : [events[0]!.id],
    });

    const releaseEvent = appendEvent(db, {
      vin: String(deal.vin),
      type: 'vehicle_funds_released',
      dealId,
      payload: {
        amount: payoutToSeller,
        currency,
        platformFeeAmount: platformFee,
        recipientId: String(deal.seller_id),
        payoutRef: release.txRef,
      },
      actorId: null,
      actorRole: null,
    });
    run(db, 'UPDATE deals SET state = ?, vehicle_released_at = ?, updated_at = ? WHERE id = ?', [
      'completed',
      release.releasedAt,
      nowIso(),
      dealId,
    ]);

    // --- Completion receipt (NFT) ---
    const listingRow = get(db, 'SELECT * FROM listings WHERE id = ?', [String(deal.listing_id)]);
    const photoHashes = listingRow ? json<string[]>(listingRow.photo_hashes as string, []) : [];
    const hashes = [
      ...photoHashes,
      ...events.filter((e) => e.payload.reportHash).map((e) => String(e.payload.reportHash)),
      ...events.filter((e) => e.payload.dashboardPhotoHash).map((e) => String(e.payload.dashboardPhotoHash)),
      release.txRef,
    ];
    const root = await evidenceRoot(hashes);
    const noteId = newId('note');
    const createdAt = nowIso();
    run(
      db,
      `INSERT INTO notes (id, vin, deal_id, buyer_id, seller_id, owner_id, price_amount, price_currency,
        evidence_root, escrow_tx_id, status, asset_id, metadata_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?)`,
      [
        noteId,
        String(deal.vin),
        dealId,
        String(deal.buyer_id),
        String(deal.seller_id),
        String(deal.buyer_id),
        priceAmount,
        currency,
        root,
        release.txRef,
        `/api/notes/${noteId}/metadata`,
        createdAt,
      ],
    );

    const noteEvent = appendEvent(db, {
      vin: String(deal.vin),
      type: 'note_completed',
      dealId,
      payload: {
        noteAssetId: null,
        evidenceRoot: root,
        escrowTxId: release.txRef,
        priceAmount,
        priceCurrency: currency,
      },
      actorId: null,
      actorRole: null,
    });

    return c.json({
      deal: serializeDeal(get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!),
      payout: { toSeller: payoutToSeller, platformFee, currency, txRef: release.txRef },
      events: [releaseEvent, noteEvent],
      note: serializeNote(get(db, 'SELECT * FROM notes WHERE id = ?', [noteId])!),
      nftNote:
        'The receipt NFT is not minted yet. Once the program and metadata are ready it is minted as a Metaplex Core asset ' +
        'to the buyer wallet. The NFT is a receipt and a claim trail, NOT a vehicle title.',
    });
  });

  // -------------------------------------------------------------------------
  // Disputes
  // -------------------------------------------------------------------------
  app.post('/deals/:id/disputes', zValidator('json', zOpenDispute), async (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    if (String(deal.state) === 'completed' || String(deal.state) === 'cancelled') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: 'The deal is already completed or cancelled.' } }, 409);
    }
    const parties = [String(deal.buyer_id), String(deal.seller_id), String(deal.inspector_id)];
    if (!parties.includes(input.openedBy)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only a party to the deal may open a dispute' } }, 403);
    }
    const existing = get(db, 'SELECT * FROM disputes WHERE deal_id = ? AND state = ?', [dealId, 'open']);
    if (existing) return c.json({ error: { code: 'INVALID_TRANSITION', message: 'This deal already has an open dispute' } }, 409);

    const disputeId = newId('dsp');
    const openedAt = nowIso();
    run(
      db,
      `INSERT INTO disputes (id, deal_id, opened_by, reason, state, outcome, arbiter_id, bond_slashed_amount,
        refunded_amount, released_amount, arbiter_note, opened_at, resolved_at)
       VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      [disputeId, dealId, input.openedBy, input.reason, openedAt],
    );

    // A dispute freezes the receipt and the escrow.
    const escrows = ctx.escrow.listForDeal(dealId);
    const frozen: EscrowDto[] = [];
    for (const escrow of escrows) {
      if (escrow.status === 'funded') {
        `Dispute ${disputeId} opened: ${input.reason.slice(0, 120)}`
        frozen.push(ctx.escrow.findById(escrow.id)!);
      } else {
        frozen.push(escrow);
      }
    }
    run(db, 'UPDATE deals SET state = ?, updated_at = ? WHERE id = ?', ['frozen', openedAt, dealId]);
    const event = appendEvent(db, {
      vin: String(deal.vin),
      type: 'dispute_opened',
      dealId,
      payload: { disputeId, reason: input.reason },
      actorId: input.openedBy,
      actorRole: roleOf(deal, input.openedBy),
    });

    return c.json(
      {
        dispute: serializeDispute(get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId])!),
        escrows: frozen.map(publicEscrow),
        event,
        note: 'Escrow and receipt are frozen. No receipt transfer happens before the arbitration ruling.',
      },
      201,
    );
  });

  app.post('/disputes/:id/resolve', zValidator('json', zResolveDispute), async (c) => {
    const disputeId = c.req.param('id');
    const input = c.req.valid('json');
    const dispute = get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
    if (!dispute) return c.json({ error: { code: 'NOT_FOUND', message: 'Dispute not found' } }, 404);
    if (String(dispute.state) !== 'open') {
      message: 'The dispute is already resolved'
    }
    const arbiter = get(db, 'SELECT * FROM actors WHERE id = ?', [input.arbiterId]);
    if (!arbiter || arbiter.role !== 'arbiter') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the arbiter may rule on a dispute' } }, 403);
    }
    const dealId = String(dispute.deal_id);
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId])!;
    const evidence = eventsForDeal(db, dealId).map((e) => e.id);

    const vehicleEscrow = ctx.escrow.findById(String(deal.escrow_ref_vehicle));
    const inspectionEscrow = ctx.escrow.findById(String(deal.escrow_ref_inspection));
    const currency = String(deal.price_currency);
    let refundedAmount = input.refundedAmount ?? null;
    let releasedAmount = input.releasedAmount ?? null;
    let bondSlashedAmount = input.bondSlashedAmount ?? null;
    let finalState: 'completed' | 'cancelled' = 'completed';

    let inspectionSettlement: { toInspector: string; toBuyer: string; currency: string } | null = null;

    if (input.outcome === 'refund_buyer') {
      if (vehicleEscrow) {
        await ctx.escrow.resolveByArbitration(vehicleEscrow.id, {
          decision: 'refund_buyer',
          toBuyer: String(deal.price_amount),
          toCounterparty: '0',
          evidenceEventIds: evidence,
        });
      }
      inspectionSettlement = await settleInspectionLeg(ctx, deal, dealId, input.arbiterId);
      refundedAmount = refundedAmount ?? String(deal.price_amount);
      finalState = 'cancelled';
    } else if (input.outcome === 'release_to_seller') {
      if (vehicleEscrow) {
        await ctx.escrow.resolveByArbitration(vehicleEscrow.id, {
          decision: 'release_to_seller',
          toBuyer: '0',
          toCounterparty: String(deal.price_amount),
          evidenceEventIds: evidence,
        });
      }
      inspectionSettlement = await settleInspectionLeg(ctx, deal, dealId, input.arbiterId);
      releasedAmount = releasedAmount ?? String(deal.price_amount);
    } else if (input.outcome === 'split') {
      const toBuyer = input.refundedAmount ?? '0';
      const toSeller = input.releasedAmount ?? String(deal.price_amount);
      if (vehicleEscrow) {
        await ctx.escrow.resolveByArbitration(vehicleEscrow.id, {
          decision: 'split',
          toBuyer,
          toCounterparty: toSeller,
          evidenceEventIds: evidence,
        });
      }
      inspectionSettlement = await settleInspectionLeg(ctx, deal, dealId, input.arbiterId);
      refundedAmount = toBuyer;
      releasedAmount = toSeller;
    } else {
      // bond_slashed: the seller failed to hand over the unit -> buyer refunded, bond slashed.
      if (vehicleEscrow) {
        await ctx.escrow.resolveByArbitration(vehicleEscrow.id, {
          decision: 'bond_slashed',
          toBuyer: String(deal.price_amount),
          toCounterparty: '0',
          evidenceEventIds: evidence,
        });
      }
      inspectionSettlement = await settleInspectionLeg(ctx, deal, dealId, input.arbiterId);
      const bond = get(
        db,
        `SELECT * FROM bonds WHERE actor_id = ? AND purpose = 'listing' AND state = 'locked' ORDER BY locked_at DESC LIMIT 1`,
        [String(deal.seller_id)],
      );
      if (bond) {
        const breakdown = slashBond(String(bond.amount), String(bond.currency), 0.5, 0.5);
        bondSlashedAmount = breakdown.slashed;
        run(db, `UPDATE bonds SET state = 'slashed', settled_at = ?, reason = ? WHERE id = ?`, [
          nowIso(),
          `Settled in dispute ${disputeId}: the slashed amount goes to the dispute fund, not the team wallet.`,
          String(bond.id),
        ]);
        run(
          db,
          'INSERT INTO audit_log (id, action, actor_id, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
          [
            newId('aud'),
            'dispute_fund_credit',
            input.arbiterId,
            'dispute',
            disputeId,
            JSON.stringify({ toDisputeFund: breakdown.toDisputeFund, toBuyerCompensation: breakdown.toBuyerCompensation }),
            nowIso(),
          ],
        );
      }
      refundedAmount = refundedAmount ?? String(deal.price_amount);
      finalState = 'cancelled';
    }

    const resolvedAt = nowIso();
    run(
      db,
      `UPDATE disputes SET state = 'resolved', outcome = ?, arbiter_id = ?, bond_slashed_amount = ?, refunded_amount = ?,
        released_amount = ?, arbiter_note = ?, resolved_at = ? WHERE id = ?`,
      [
        input.outcome,
        input.arbiterId,
        bondSlashedAmount,
        refundedAmount,
        releasedAmount,
        input.arbiterNote,
        resolvedAt,
        disputeId,
      ],
    );

    // If the deal goes back to the seller, no receipt transfers and the listing returns to live.
    if (finalState === 'cancelled') {
      run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE id = ?', ['listed', resolvedAt, String(deal.listing_id)]);
    } else {
      run(db, 'UPDATE listings SET status = ?, updated_at = ? WHERE id = ?', ['completed', resolvedAt, String(deal.listing_id)]);
    }
    run(db, 'UPDATE deals SET state = ?, updated_at = ? WHERE id = ?', [finalState, resolvedAt, dealId]);

    const event = appendEvent(db, {
      vin: String(deal.vin),
      type: 'dispute_resolved',
      dealId,
      payload: {
        disputeId,
        outcome: input.outcome,
        refundedAmount: refundedAmount ?? undefined,
        releasedAmount: releasedAmount ?? undefined,
        bondSlashedAmount: bondSlashedAmount ?? undefined,
        arbiterNote:
          inspectionSettlement && inspectionSettlement.toInspector !== '0'
            ? `${input.arbiterNote} | inspection paid ${inspectionSettlement.toInspector} ${inspectionSettlement.currency}`
            : input.arbiterNote,
      },
      actorId: input.arbiterId,
      actorRole: 'arbiter',
    });

    // The listing bond is returned after a clean deal.
    if (input.outcome === 'release_to_seller') {
      const bond = get(
        db,
        `SELECT * FROM bonds WHERE actor_id = ? AND purpose = 'listing' AND state = 'locked' ORDER BY locked_at DESC LIMIT 1`,
        [String(deal.seller_id)],
      );
      if (bond) {
        run(db, `UPDATE bonds SET state = 'returned', settled_at = ? WHERE id = ?`, [resolvedAt, String(bond.id)]);
      }
    }

    return c.json({
      dispute: serializeDispute(get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId])!),
      escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow),
      event,
      breakdown: { refundedAmount, releasedAmount, bondSlashedAmount },
    });
  });

  // -------------------------------------------------------------------------
  // Pembacaan
  // -------------------------------------------------------------------------
  app.get('/deals', (c) => {
    const actorId = c.req.query('actorId');
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (actorId) {
      clauses.push('(buyer_id = ? OR seller_id = ? OR inspector_id = ?)');
      params.push(actorId, actorId, actorId);
    }
    const state = c.req.query('state');
    if (state) {
      clauses.push('state = ?');
      params.push(state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = all(db, `SELECT * FROM deals ${where} ORDER BY created_at DESC LIMIT 200`, params);
    return c.json({ deals: rows.map(serializeDeal) });
  });

  app.get('/deals/:id', (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    const reports = all(db, 'SELECT * FROM inspection_reports WHERE deal_id = ? ORDER BY created_at DESC', [dealId]).map(
      serializeReport,
    );
    const dispute = get(db, 'SELECT * FROM disputes WHERE deal_id = ? ORDER BY opened_at DESC LIMIT 1', [dealId]);
    const note = get(db, 'SELECT * FROM notes WHERE deal_id = ?', [dealId]);
    const buyer = get(db, 'SELECT * FROM actors WHERE id = ?', [String(deal.buyer_id)]);
    const seller = get(db, 'SELECT * FROM actors WHERE id = ?', [String(deal.seller_id)]);
    const inspector = get(db, 'SELECT * FROM actors WHERE id = ?', [String(deal.inspector_id)]);
    return c.json({
      deal: serializeDeal(deal),
      escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow),
      reports,
      dispute: dispute ? serializeDispute(dispute) : null,
      note: note ? serializeNote(note) : null,
      parties: {
        buyer: buyer ? serializeActor(buyer) : null,
        seller: seller ? serializeActor(seller) : null,
        inspector: inspector ? serializeActor(inspector) : null,
      },
      events: eventsForDeal(db, dealId),
    });
  });

  app.get('/deals/:id/escrows', (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT id FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal not found' } }, 404);
    return c.json({ escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow) });
  });

  // -------------------------------------------------------------------------
    // Receipt (NFT pointer)
  // -------------------------------------------------------------------------
  app.get('/notes', (c) => {
    const ownerId = c.req.query('ownerId');
    const vin = c.req.query('vin');
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ownerId) {
      clauses.push('owner_id = ?');
      params.push(ownerId);
    }
    if (vin) {
      clauses.push('vin = ?');
      params.push(vin.toUpperCase());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = all(db, `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT 200`, params);
    return c.json({ notes: rows.map(serializeNote) });
  });

  /** Metadata compatible with Metaplex Core/DAS. Raw photos never go on-chain. */
  app.get('/notes/:id/metadata', (c) => {
    const note = get(db, 'SELECT * FROM notes WHERE id = ?', [c.req.param('id')]);
    if (!note) return c.json({ error: { code: 'NOT_FOUND', message: 'Receipt not found' } }, 404);
    return c.json({
      name: `VIN Receipt ${note.vin}`,
      symbol: 'VINNOTE',
      description:
        'A cross-border vehicle deal receipt. A claim and transaction trail, not a vehicle title (not a BPKB/title). ' +
        'Legal ownership follows the official documents of the origin and destination countries.',
      image: '',
      external_url: `/vin/${note.vin}`,
      attributes: [
        { trait_type: 'VIN', value: String(note.vin) },
        { trait_type: 'Deal', value: String(note.deal_id) },
        { trait_type: 'Price', value: `${note.price_amount} ${note.price_currency}` },
        { trait_type: 'Status', value: String(note.status) },
        { trait_type: 'EscrowTx', value: String(note.escrow_tx_id ?? '') },
        { trait_type: 'EvidenceRoot', value: String(note.evidence_root) },
      ],
      properties: {
        category: 'image',
        files: [],
        creators: [],
        vin_notice:
          'This NFT is a receipt and a claim trail, not a title. Photos and raw reports stay off-chain; ' +
          'only the hash is anchored on-chain.',
      },
    });
  });

  return app;

  function roleOf(deal: Record<string, unknown>, actorId: string) {
    if (actorId === deal.buyer_id) return 'buyer' as const;
    if (actorId === deal.seller_id) return 'seller' as const;
    if (actorId === deal.inspector_id) return 'inspector' as const;
    return null;
  }
}

function hasOpenDispute(db: AppContext['db'], dealId: string): boolean {
  const row = get(db, `SELECT id FROM disputes WHERE deal_id = ? AND state = 'open'`, [dealId]);
  return Boolean(row);
}

function publicEscrow(escrow: EscrowDto) {
  return {
    id: escrow.id,
    dealId: escrow.dealId,
    leg: escrow.leg,
    provider: escrow.provider,
    amount: escrow.amount,
    currency: escrow.currency,
    status: escrow.status,
    releaseTerms: escrow.releaseTerms,
    fundedAt: escrow.fundedAt,
    releasedAt: escrow.releasedAt,
    txRef: escrow.txRef,
  };
}

/** Money arithmetic uses scaled integers, never floats. */
function subtract(a: string, b: string, currency: string): string {
  return fromMinorUnits(toMinorUnits(a, currency) - toMinorUnits(b, currency), currency);
}

function add(a: string, b: string, currency: string): string {
  return fromMinorUnits(toMinorUnits(a, currency) + toMinorUnits(b, currency), currency);
}
