'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Deal, Dispute, VinEvent } from '@vin/shared';
import { useSession } from './SessionProvider';
import { Notice } from './Chips';
import { formatAmount, randomSha256, shortHash } from '@/lib/format';

interface Props {
  deal: Deal;
  dispute: Dispute | null;
  events: VinEvent[];
}

type Msg = { tone: 'safe' | 'danger' | 'info'; text: string } | null;

async function post(path: string, body: unknown, actorId: string | null): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actorId ? { 'x-actor-id': actorId } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as { message?: string; details?: unknown } | undefined;
    const details = err?.details ? ` (${JSON.stringify(err.details)})` : '';
    throw new Error(`${err?.message ?? `HTTP ${res.status}`}${details}`);
  }
  return data;
}

function nextStep(deal: Deal, dispute: Dispute | null, events: VinEvent[]): string {
  if (dispute && dispute.state === 'open') return 'Waiting for the arbiter ruling. Escrow and receipt are frozen.';
  switch (deal.state) {
    case 'escrow_pending':
      return 'The buyer funds the vehicle escrow and the inspection escrow (two separate legs).';
    case 'inspecting':
      return events.some((e) => e.type === 'report_uploaded')
        ? 'The buyer accepts or rejects the report within the deadline.'
        : 'The workshop inspects the vehicle on site and uploads the minimum report.';
    case 'inspection_accepted':
      return 'Waiting for handover confirmation under the terms locked at the start.';
    case 'handover_pending':
      return 'Handover terms confirmed. Vehicle funds may now release to the seller.';
    case 'completed':
      return 'Deal completed. The receipt is recorded as a claim trail, not a title.';
    case 'frozen':
      return 'Deal is frozen. No receipt transfers before the arbitration ruling.';
    default:
      return 'No next step yet.';
  }
}

export function DealActions({ deal, dispute, events }: Props) {
  const { actor } = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const isBuyer = actor?.id === deal.buyerId;
  const isSeller = actor?.id === deal.sellerId;
  const isInspector = actor?.id === deal.inspectorId;
  const isArbiter = actor?.role === 'arbiter';

  const [report, setReport] = useState({
    odometerKm: '',
    inspectedAt: new Date().toISOString().slice(0, 16),
    reportHash: '',
    dashboardPhotoHash: '',
    conditionSummary: '',
    checklist: {
      vin_matches_unit: true,
      dashboard_photo: true,
      odometer_documented: true,
      main_condition: true,
      date_and_location: true,
    },
  });
  const [accept, setAccept] = useState({ acknowledgeAnomaly: false });
  const [handover, setHandover] = useState({ method: 'load_proof' as 'handover_location_confirmed' | 'load_proof' | 'mutual_confirmation' });
  const [disputeForm, setDisputeForm] = useState({ reason: '' });
  const [resolveForm, setResolveForm] = useState({
    outcome: 'release_to_seller' as 'refund_buyer' | 'release_to_seller' | 'split' | 'bond_slashed',
    refundedAmount: '',
    releasedAmount: '',
    bondSlashedAmount: '',
    arbiterNote: '',
  });

  const hasAnomaly = events.some((e) => e.type === 'odometer_anomaly');
  const canDispute = ['escrow_pending', 'inspecting', 'inspection_accepted', 'handover_pending'].includes(deal.state) && !dispute;

  async function act(fn: () => Promise<Record<string, unknown>>, success: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'safe', text: success });
      router.refresh();
    } catch (error) {
      setMsg({ tone: 'danger', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Notice tone={dispute?.state === 'open' ? 'danger' : 'info'} title="Next step">
        {nextStep(deal, dispute, events)}
      </Notice>

      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}

      {/* Buyer: fund the escrow */}
      {deal.state === 'escrow_pending' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Escrow awaiting funding</h4>
          <p className="mt-1 text-xs text-mist-400">
            Two separate legs: vehicle funds {formatAmount(deal.priceAmount, deal.priceCurrency)} and inspection funds{' '}
            {formatAmount(deal.inspectionFeeAmount)}. Production: a licensed payment provider in the corridor; on-chain: the Anchor program.
          </p>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isBuyer}
              onClick={() => act(() => post(`/api/deals/${deal.id}/fund`, { payerRef: deal.buyerId }, actor?.id ?? null), 'Escrow funded. Deal locked.')}
            >
              {isBuyer ? 'Fund the escrow now' : 'Only the buyer can fund the escrow'}
            </button>
          </div>
        </div>
      )}

      {/* Workshop: upload the report */}
      {deal.state === 'inspecting' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Upload inspection report</h4>
          <p className="mt-1 text-xs text-mist-400">
            Raw files stay off-chain; only the hash is anchored. The report must cover the minimum items.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="odo">Odometer (km)</label>
              <input
                id="odo"
                inputMode="numeric"
                value={report.odometerKm}
                onChange={(e) => setReport({ ...report, odometerKm: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="30240"
              />
            </div>
            <div>
              <label htmlFor="inspectedAt">Inspection time</label>
              <input
                id="inspectedAt"
                type="datetime-local"
                value={report.inspectedAt}
                onChange={(e) => setReport({ ...report, inspectedAt: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="reportHash">Report hash (sha256)</label>
              <div className="flex gap-2">
                <input id="reportHash" value={report.reportHash} onChange={(e) => setReport({ ...report, reportHash: e.target.value })} placeholder="64 hex" />
                <button type="button" className="ghost whitespace-nowrap" onClick={() => setReport({ ...report, reportHash: randomSha256() })}>
                  sample
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="dashHash">Dashboard photo hash (sha256)</label>
              <div className="flex gap-2">
                <input id="dashHash" value={report.dashboardPhotoHash} onChange={(e) => setReport({ ...report, dashboardPhotoHash: e.target.value })} placeholder="64 hex" />
                <button type="button" className="ghost whitespace-nowrap" onClick={() => setReport({ ...report, dashboardPhotoHash: randomSha256() })}>
                  sample
                </button>
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="summary">Main condition</label>
              <textarea
                id="summary"
                rows={3}
                value={report.conditionSummary}
                onChange={(e) => setReport({ ...report, conditionSummary: e.target.value })}
                placeholder="Findings on the inspection date — not a warranty until the vehicle reaches the buyer's country."
              />
            </div>
          </div>
          <fieldset className="mt-3">
            <legend className="text-[0.7rem] uppercase tracking-wider text-mist-400">Standard checklist</legend>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              {Object.entries(report.checklist).map(([key, checked]) => (
                <label key={key} className="flex items-center gap-2 text-xs normal-case text-mist-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={checked}
                    onChange={(e) => setReport({ ...report, checklist: { ...report.checklist, [key]: e.target.checked } })}
                  />
                  {key}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isInspector || report.odometerKm === '' || report.reportHash.length !== 64 || report.dashboardPhotoHash.length !== 64}
              onClick={() =>
                act(
                  () =>
                    post(
                      `/api/deals/${deal.id}/reports`,
                      {
                        inspectorId: deal.inspectorId,
                        odometerKm: Number(report.odometerKm),
                        inspectedAt: new Date(report.inspectedAt).toISOString(),
                        reportHash: report.reportHash,
                        dashboardPhotoHash: report.dashboardPhotoHash,
                        conditionSummary: report.conditionSummary,
                        standardVersion: 'vin-report-v1',
                        checklist: report.checklist,
                      },
                      actor?.id ?? null,
                    ),
                  'Report uploaded. The hash is anchored in the event log.',
                )
              }
            >
              {isInspector ? 'Upload report' : 'Only the selected workshop can upload'}
            </button>
          </div>
        </div>
      )}

      {/* Buyer: accept the report */}
      {deal.state === 'inspecting' && events.some((e) => e.type === 'report_uploaded') && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Accept report</h4>
          {hasAnomaly ? (
            <div className="mt-2">
              <Notice tone="warn" title="This VIN has an odometer anomaly">
                An anomaly is not an automatic rejection, but a warning the buyer must see before funds release.
              </Notice>
              <label className="mt-2 flex items-center gap-2 text-xs normal-case text-mist-300">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={accept.acknowledgeAnomaly}
                  onChange={(e) => setAccept({ acknowledgeAnomaly: e.target.checked })}
                />
                I have read the odometer anomaly warning
              </label>
            </div>
          ) : null}
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !isBuyer || (hasAnomaly && !accept.acknowledgeAnomaly)}
              onClick={() =>
                act(async () => {
                  const detail = await fetch(`/api/deals/${deal.id}`).then((r) => r.json());
                  const reportId: string = detail.reports?.[0]?.id;
                  if (!reportId) throw new Error('The report is not available on the server yet');
                  return post(
                    `/api/deals/${deal.id}/reports/${reportId}/accept`,
                    { buyerId: deal.buyerId, acknowledgeAnomaly: accept.acknowledgeAnomaly },
                    actor?.id ?? null,
                  );
                }, 'Report accepted. Inspection funds release to the workshop after the platform fee.')
              }
            >
              {isBuyer ? 'Accept the report, release inspection funds' : 'Only the buyer can accept the report'}
            </button>
          </div>
        </div>
      )}

      {/* Handover */}
      {['inspection_accepted', 'handover_pending'].includes(deal.state) && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Confirm handover</h4>
          <p className="mt-1 text-xs text-mist-400">
            Locked terms: {deal.handoverTerms}. Confirmed by: {deal.handoverConfirmedBy.length} parties.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="method">Evidence method</label>
              <select id="method" value={handover.method} onChange={(e) => setHandover({ method: e.target.value as typeof handover.method })}>
                <option value="handover_location_confirmed">Handover at location</option>
                <option value="load_proof">Load proof</option>
                <option value="mutual_confirmation">Confirmation by both parties</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                className="ghost w-full"
                disabled={busy || (!isBuyer && !isSeller)}
                onClick={() =>
                  act(
                    () => post(`/api/deals/${deal.id}/handover`, { actorId: actor?.id, method: handover.method }, actor?.id ?? null),
                    'Confirmation recorded.',
                  )
                }
              >
                {isBuyer || isSeller ? 'Confirm as myself' : 'Buyer or seller only'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Vehicle fund release */}
      {deal.state === 'handover_pending' && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Vehicle fund release</h4>
          <p className="mt-1 text-xs text-mist-400">
            Vehicle funds do not release before handover conditions are met. Once released, the completion receipt is recorded to the buyer.
          </p>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                act(() => post(`/api/deals/${deal.id}/release-vehicle`, {}, actor?.id ?? null), 'Vehicle funds released. The completion receipt is recorded.')
              }
            >
              Release vehicle funds and record the receipt
            </button>
          </div>
        </div>
      )}

      {/* Dispute */}
      {canDispute && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Open a dispute</h4>
          <p className="mt-1 text-xs text-mist-400">
            A dispute freezes the escrow and the receipt. Use it only when the two sides cannot agree.
          </p>
          <div className="mt-3">
            <label htmlFor="reason">Reason</label>
            <textarea
              id="reason"
              rows={3}
              value={disputeForm.reason}
              onChange={(e) => setDisputeForm({ reason: e.target.value })}
              placeholder="The seller did not hand over the unit / the report appears not to match the unit / another reason."
            />
          </div>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || !actor || disputeForm.reason.length < 10}
              onClick={() => act(() => post(`/api/deals/${deal.id}/disputes`, { openedBy: actor?.id, reason: disputeForm.reason }, actor?.id ?? null), 'Dispute opened. The escrow is frozen.')}
            >
              Open a dispute
            </button>
          </div>
        </div>
      )}

      {/* Arbiter */}
      {dispute?.state === 'open' && isArbiter && (
        <div className="card p-4">
          <h4 className="text-sm font-medium">Arbiter ruling</h4>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="outcome">Ruling</label>
              <select id="outcome" value={resolveForm.outcome} onChange={(e) => setResolveForm({ ...resolveForm, outcome: e.target.value as typeof resolveForm.outcome })}>
                <option value="refund_buyer">Funds back to the buyer</option>
                <option value="release_to_seller">Funds released to the seller</option>
                <option value="split">Partial release (split)</option>
                <option value="bond_slashed">Seller at fault: bond slashed</option>
              </select>
            </div>
            {resolveForm.outcome === 'split' ? (
              <>
                <div>
                  <label htmlFor="toBuyer">Back to the buyer</label>
                  <input id="toBuyer" value={resolveForm.refundedAmount} onChange={(e) => setResolveForm({ ...resolveForm, refundedAmount: e.target.value })} placeholder="1000" />
                </div>
                <div>
                  <label htmlFor="toSeller">Released to the seller</label>
                  <input id="toSeller" value={resolveForm.releasedAmount} onChange={(e) => setResolveForm({ ...resolveForm, releasedAmount: e.target.value })} placeholder="44000" />
                </div>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <label htmlFor="arbNote">Arbiter note</label>
              <textarea id="arbNote" rows={3} value={resolveForm.arbiterNote} onChange={(e) => setResolveForm({ ...resolveForm, arbiterNote: e.target.value })} />
            </div>
          </div>
          <div className="mt-3">
            <button
              className="primary"
              disabled={busy || resolveForm.arbiterNote.length < 4}
              onClick={() =>
                act(
                  () =>
                    post(
                      `/api/disputes/${dispute.id}/resolve`,
                      {
                        arbiterId: actor?.id,
                        outcome: resolveForm.outcome,
                        refundedAmount: resolveForm.refundedAmount || undefined,
                        releasedAmount: resolveForm.releasedAmount || undefined,
                        bondSlashedAmount: resolveForm.bondSlashedAmount || undefined,
                        arbiterNote: resolveForm.arbiterNote,
                      },
                      actor?.id ?? null,
                    ),
                  'Dispute resolved. The slashed bond goes to the dispute fund, not the team wallet.',
                )
              }
            >
              Rule on the dispute
            </button>
          </div>
        </div>
      )}

      {dispute?.state === 'open' && !isArbiter ? (
        <Notice tone="danger" title={`Dispute opened by ${shortHash(dispute.openedBy, 8, 4)}`}>
          Sign in as the arbiter to rule on the dispute.
        </Notice>
      ) : null}
    </div>
  );
}
