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
import { appendEvent, eventsForDeal, latestOdometer } from '../events.js';
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

export function dealRoutes(ctx: AppContext): Hono {
  const app = new Hono();
  const { db } = ctx;

  // -------------------------------------------------------------------------
  // Pembeli mengunci deal
  // -------------------------------------------------------------------------
  app.post('/listings/:id/deals', zValidator('json', zCommitDeal), async (c) => {
    const listingId = c.req.param('id');
    const input = c.req.valid('json');
    const listing = get(db, 'SELECT * FROM listings WHERE id = ?', [listingId]);
    if (!listing) return c.json({ error: { code: 'NOT_FOUND', message: 'Listing tidak ditemukan' } }, 404);
    if (String(listing.status) !== 'listed') {
      return c.json(
        { error: { code: 'LISTING_ALREADY_RESERVED', message: 'Listing ini sudah dikunci pembeli lain atau sudah selesai.' } },
        409,
      );
    }

    const buyer = get(db, 'SELECT * FROM actors WHERE id = ?', [input.buyerId]);
    if (!buyer || buyer.role !== 'buyer') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya akun pembeli yang boleh mengunci deal' } }, 403);
    }
    if (String(buyer.verification) === 'none') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Pembeli perlu verifikasi dasar sebelum membayar' } }, 403);
    }

    const inspector = get(db, 'SELECT * FROM actors WHERE id = ?', [input.inspectorId]);
    if (!inspector || inspector.role !== 'inspector') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Bengkel inspeksi tidak ditemukan' } }, 404);
    }
    if (String(inspector.verification) !== 'business_verified') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Bengkel belum lolos cek identitas' } }, 403);
    }
    if (lockedBondTotal(db, input.inspectorId, 'inspection_capacity') <= 0) {
      return c.json({ error: { code: 'BOND_REQUIRED', message: 'Bengkel belum mengunci jaminan kapasitas inspeksi' } }, 400);
    }
    // Penjual tidak boleh menunjuk inspektor untuk unitnya sendiri; bengkel
    // terafiliasi dengan penjual diblokir dari order itu.
    if (affiliateIds(db, String(listing.seller_id)).includes(input.inspectorId)) {
      return c.json(
        {
          error: {
            code: 'INSPECTOR_CONFLICT',
            message: 'Bengkel ini terafiliasi dengan penjual dan diblokir dari order unit tersebut.',
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

    // Baris deal ditulis dulu (escrow merujuk deal_id), lalu escrow dibuat,
    // lalu referensinya diperbarui. Urutan ini menghormati foreign key.
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

    // Dua escrow terpisah: dana kendaraan dan dana inspeksi tidak pernah dicampur.
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
        next: `Pembeli mendanai escrow: POST /api/deals/${dealId}/fund`,
        note:
          'Harga kendaraan dan biaya inspeksi berada di escrow yang TERPISAH. ' +
          'Dana kendaraan tidak cair sebelum syarat serah terima terpenuhi.',
      },
      201,
    );
  });

  /**
   * Konfirmasi pendanaan escrow (produksi: webhook dari penyedia pembayaran berizin).
   * Event `deal_committed` ditulis SETELAH dana benar-benar masuk escrow.
   */
  app.post('/deals/:id/fund', async (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    if (String(deal.state) !== 'escrow_pending') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Deal berstatus ${deal.state}, tidak bisa didanai ulang.` } }, 409);
    }
    const vehicle = ctx.escrow.findById(String(deal.escrow_ref_vehicle));
    const inspection = ctx.escrow.findById(String(deal.escrow_ref_inspection));
    if (!vehicle || !inspection) return c.json({ error: { code: 'NOT_FOUND', message: 'Escrow tidak ditemukan' } }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { payerRef?: string };
    const payerRef = body.payerRef ?? String(deal.buyer_id);
    // Waktu simulasi hanya berlaku di mode demo (lihat context.ts).
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
      note: 'Deal dikunci. Listing yang sama tidak bisa dijual ke pembeli kedua selama escrow aktif.',
    });
  });

  // -------------------------------------------------------------------------
  // Inspeksi
  // -------------------------------------------------------------------------
  app.post('/deals/:id/reports', zValidator('json', zUploadReport), (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    if (String(deal.state) !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Laporan tidak bisa diunggah pada status ${deal.state}` } }, 409);
    }
    if (String(deal.inspector_id) !== input.inspectorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya bengkel yang dipilih pembeli yang boleh mengunggah laporan' } }, 403);
    }
    const standard = reportMeetsStandard(input.checklist as unknown as Record<string, boolean>);
    if (!standard.ok) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Laporan belum memenuhi standar minimum.',
            details: { missing: standard.missing },
          },
        },
        400,
      );
    }

    const vin = String(deal.vin);
    const previous = latestOdometer(db, vin);
    const previousKm = previous ? previous.km : null;
    const anomaly = odometerIsAnomaly(input.odometerKm, previousKm);

    const reportId = newId('rpt');
    const createdAt = nowIso();
    // Waktu simulasi demo: metrik durasi kerja bengkel jadi masuk akal.
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
                'Anomali kilometer bukan penolakan otomatis, tetapi peringatan yang WAJIB dilihat pembeli sebelum dana dilepas.',
              previousOdometerKm: previousKm,
            }
          : { flagged: false },
        offChainNote: 'File mentah disimpan off-chain. Yang dikunci hanya hash.',
      },
      201,
    );
  });

  /** Pembeli menerima laporan -> dana inspeksi lepas ke bengkel (setelah fee). */
  app.post('/deals/:id/reports/:reportId/accept', async (c) => {
    const dealId = c.req.param('id');
    const reportId = c.req.param('reportId');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    if (String(deal.state) !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Tidak ada laporan menunggu pada status ${deal.state}` } }, 409);
    }
    const report = get(db, 'SELECT * FROM inspection_reports WHERE id = ? AND deal_id = ?', [reportId, dealId]);
    if (!report) return c.json({ error: { code: 'NOT_FOUND', message: 'Laporan tidak ditemukan' } }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { buyerId?: string };
    const buyerId = body.buyerId ?? actorIdFromRequest(c.req.header('x-actor-id'));
    if (!buyerId || buyerId !== String(deal.buyer_id)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya pembeli yang boleh menerima laporan' } }, 403);
    }
    // Anomali kilometer wajib terlihat sebelum dana dilepas.
    const anomalies = eventsForDeal(db, dealId).filter((e) => e.type === 'odometer_anomaly');
    const acknowledged = (body as { acknowledgeAnomaly?: boolean }).acknowledgeAnomaly === true;
    if (anomalies.length > 0 && !acknowledged) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Ada anomali kilometer pada VIN ini. Konfirmasi dulu bahwa peringatan sudah dibaca.',
            details: { anomalies: anomalies.map((a) => a.payload.anomaly) },
          },
        },
        400,
      );
    }

    const escrow = ctx.escrow.findById(String(deal.escrow_ref_inspection));
    if (!escrow) return c.json({ error: { code: 'NOT_FOUND', message: 'Escrow inspeksi tidak ditemukan' } }, 404);
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
      type: 'inspeksi_dana_lepas',
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
      next: `Konfirmasi serah terima: POST /api/deals/${dealId}/handover`,
    });
  });

  // -------------------------------------------------------------------------
  // Serah terima & pelepasan dana kendaraan
  // -------------------------------------------------------------------------
  app.post('/deals/:id/handover', zValidator('json', zConfirmHandover), (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    const state = String(deal.state);
    if (state === 'frozen') {
      return c.json({ error: { code: 'DEAL_FROZEN', message: 'Deal dibekukan. Serah terima tidak bisa dikonfirmasi sampai arbitrase memutuskan.' } }, 409);
    }
    if (state !== 'inspection_accepted' && state !== 'handover_pending' && state !== 'inspecting') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Konfirmasi serah terima tidak berlaku pada status ${state}` } }, 409);
    }
    const actorId = input.actorId;
    const allowed = [String(deal.buyer_id), String(deal.seller_id)];
    if (!allowed.includes(actorId)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya pembeli atau penjual yang boleh mengonfirmasi serah terima' } }, 403);
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
      next: preconditions.ok ? `POST /api/deals/${dealId}/release-vehicle` : 'Menunggu konfirmasi pihak lain.',
    });
  });

  /**
   * Pelepasan dana kendaraan: hanya setelah syarat serah terima yang dikunci
   * di awal terpenuhi. Nota selesai dicatat setelah dana lepas.
   */
  app.post('/deals/:id/release-vehicle', async (c) => {
    const dealId = c.req.param('id');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    if (String(deal.state) !== 'handover_pending') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: `Status ${deal.state} belum siap untuk pelepasan dana kendaraan.` } }, 409);
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
            message: 'Syarat serah terima belum terpenuhi. Dana kendaraan tidak boleh cair.',
            details: { missing: preconditions.missing },
          },
        },
        409,
      );
    }

    const escrow = ctx.escrow.findById(String(deal.escrow_ref_vehicle));
    if (!escrow) return c.json({ error: { code: 'NOT_FOUND', message: 'Escrow kendaraan tidak ditemukan' } }, 404);
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
      type: 'kendaraan_dana_lepas',
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

    // --- Nota selesai (NFT) ---
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
        'NFT nota belum dicetak. Setelah program/metadata siap, nota ini dicetak sebagai Metaplex Core asset ' +
        'ke dompet pembeli. NFT adalah nota dan jejak klaim, BUKAN surat kendaraan.',
    });
  });

  // -------------------------------------------------------------------------
  // Sengketa
  // -------------------------------------------------------------------------
  app.post('/deals/:id/disputes', zValidator('json', zOpenDispute), async (c) => {
    const dealId = c.req.param('id');
    const input = c.req.valid('json');
    const deal = get(db, 'SELECT * FROM deals WHERE id = ?', [dealId]);
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    if (String(deal.state) === 'completed' || String(deal.state) === 'cancelled') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Deal sudah selesai/dibatalkan.' } }, 409);
    }
    const parties = [String(deal.buyer_id), String(deal.seller_id), String(deal.inspector_id)];
    if (!parties.includes(input.openedBy)) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya pihak dalam deal yang boleh membuka sengketa' } }, 403);
    }
    const existing = get(db, 'SELECT * FROM disputes WHERE deal_id = ? AND state = ?', [dealId, 'open']);
    if (existing) return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Sudah ada sengketa terbuka untuk deal ini' } }, 409);

    const disputeId = newId('dsp');
    const openedAt = nowIso();
    run(
      db,
      `INSERT INTO disputes (id, deal_id, opened_by, reason, state, outcome, arbiter_id, bond_slashed_amount,
        refunded_amount, released_amount, arbiter_note, opened_at, resolved_at)
       VALUES (?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL)`,
      [disputeId, dealId, input.openedBy, input.reason, openedAt],
    );

    // Sengketa membekukan nota dan escrow.
    const escrows = ctx.escrow.listForDeal(dealId);
    const frozen: EscrowDto[] = [];
    for (const escrow of escrows) {
      if (escrow.status === 'funded') {
        await ctx.escrow.freeze(escrow.id, `Sengketa ${disputeId} dibuka: ${input.reason.slice(0, 120)}`);
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
        note: 'Escrow dan nota dibekukan. Transfer nota tidak terjadi sebelum keputusan arbitrase.',
      },
      201,
    );
  });

  app.post('/disputes/:id/resolve', zValidator('json', zResolveDispute), async (c) => {
    const disputeId = c.req.param('id');
    const input = c.req.valid('json');
    const dispute = get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
    if (!dispute) return c.json({ error: { code: 'NOT_FOUND', message: 'Sengketa tidak ditemukan' } }, 404);
    if (String(dispute.state) !== 'open') {
      return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Sengketa sudah diputus' } }, 409);
    }
    const arbiter = get(db, 'SELECT * FROM actors WHERE id = ?', [input.arbiterId]);
    if (!arbiter || arbiter.role !== 'arbiter') {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Hanya arbiter yang boleh memutuskan sengketa' } }, 403);
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

    if (input.outcome === 'refund_buyer') {
      if (vehicleEscrow) await ctx.escrow.refund(vehicleEscrow.id, input.arbiterNote);
      if (inspectionEscrow && inspectionEscrow.status === 'funded') {
        await ctx.escrow.refund(inspectionEscrow.id, 'Laporan batal karena sengketa');
      }
      refundedAmount = refundedAmount ?? String(deal.price_amount);
      finalState = 'cancelled';
    } else if (input.outcome === 'release_to_seller') {
      if (vehicleEscrow) {
        await ctx.escrow.release(vehicleEscrow.id, {
          recipientRef: String(deal.seller_id),
          evidenceEventIds: evidence,
        });
      }
      if (inspectionEscrow && inspectionEscrow.status === 'funded') {
        await ctx.escrow.release(inspectionEscrow.id, {
          recipientRef: String(deal.inspector_id),
          evidenceEventIds: evidence,
        });
      }
      releasedAmount = releasedAmount ?? String(deal.price_amount);
    } else if (input.outcome === 'split') {
      const toBuyer = input.refundedAmount ?? '0';
      const toSeller = input.releasedAmount ?? String(deal.price_amount);
      if (vehicleEscrow) {
        await ctx.escrow.partialRelease(vehicleEscrow.id, { toBuyer, toSeller }, evidence);
      }
      refundedAmount = toBuyer;
      releasedAmount = toSeller;
    } else {
      // bond_slashed: penjual gagal menyerahkan unit -> pembeli kembali, jaminan terpotong.
      if (vehicleEscrow) await ctx.escrow.refund(vehicleEscrow.id, input.arbiterNote);
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
          `Diputus dalam sengketa ${disputeId}: potongan masuk kas sengketa, bukan dompet tim.`,
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

    // Jika deal kembali dipegang penjual, nota tidak ditransfer dan listing kembali tayang.
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
        arbiterNote: input.arbiterNote,
      },
      actorId: input.arbiterId,
      actorRole: 'arbiter',
    });

    // Jaminan listing dikembalikan bila deal bersih.
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
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
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
    if (!deal) return c.json({ error: { code: 'NOT_FOUND', message: 'Deal tidak ditemukan' } }, 404);
    return c.json({ escrows: ctx.escrow.listForDeal(dealId).map(publicEscrow) });
  });

  // -------------------------------------------------------------------------
  // Nota (NFT pointer)
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

  /** Metadata kompatibel Metaplex Core/DAS. Foto asli tidak ditaruh di chain. */
  app.get('/notes/:id/metadata', (c) => {
    const note = get(db, 'SELECT * FROM notes WHERE id = ?', [c.req.param('id')]);
    if (!note) return c.json({ error: { code: 'NOT_FOUND', message: 'Nota tidak ditemukan' } }, 404);
    return c.json({
      name: `VIN Nota ${note.vin}`,
      symbol: 'VINNOTE',
      description:
        'Nota deal kendaraan lintas negara. Jejak klaim dan transaksi, bukan surat kendaraan (bukan BPKB/title). ' +
        'Kepemilikan hukum mengikuti dokumen resmi negara asal dan tujuan.',
      image: '',
      external_url: `/vin/${note.vin}`,
      attributes: [
        { trait_type: 'VIN', value: String(note.vin) },
        { trait_type: 'Deal', value: String(note.deal_id) },
        { trait_type: 'Harga', value: `${note.price_amount} ${note.price_currency}` },
        { trait_type: 'Status', value: String(note.status) },
        { trait_type: 'EscrowTx', value: String(note.escrow_tx_id ?? '') },
        { trait_type: 'EvidenceRoot', value: String(note.evidence_root) },
      ],
      properties: {
        category: 'image',
        files: [],
        creators: [],
        vin_notice:
          'NFT ini adalah nota dan jejak klaim, bukan title/BPKB. Foto dan laporan mentah disimpan off-chain; ' +
          'yang dikunci on-chain hanya hash.',
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

/** Aritmetika uang memakai bilangan bulat terskala, bukan float. */
function subtract(a: string, b: string, currency: string): string {
  return fromMinorUnits(toMinorUnits(a, currency) - toMinorUnits(b, currency), currency);
}

function add(a: string, b: string, currency: string): string {
  return fromMinorUnits(toMinorUnits(a, currency) + toMinorUnits(b, currency), currency);
}
