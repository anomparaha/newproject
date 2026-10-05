'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { Deal, Dispute, VinEvent } from '@vin/shared';
import { useSession } from './SessionProvider';
import { Notice } from './Chips';
import { Icon } from './Icons';
import { formatAmount, randomSha256, shortHash } from '@/lib/format';

interface Props {
  deal: Deal;
  dispute: Dispute | null;
  events: VinEvent[];
}

type Msg = { tone: 'safe' | 'danger' | 'info'; text: string } | null;

async function post(
  path: string,
  body: unknown,
  authHeaders: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
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

function ActionCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="card p-5 sm:p-6 bg-white shadow-xs border-line">
      <h4 className="text-base font-bold text-ink">{title}</h4>
      {description ? <p className="mt-1 text-xs leading-relaxed text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function DealActions({ deal, dispute, events }: Props) {
  const { actor, authHeaders } = useSession();
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
  const [handover, setHandover] = useState({
    method: 'load_proof' as 'handover_location_confirmed' | 'load_proof' | 'mutual_confirmation',
  });
  const [disputeForm, setDisputeForm] = useState({ reason: '' });
  const [resolveForm, setResolveForm] = useState({
    outcome: 'release_to_seller' as 'refund_buyer' | 'release_to_seller' | 'split' | 'bond_slashed',
    refundedAmount: '',
    releasedAmount: '',
    bondSlashedAmount: '',
    arbiterNote: '',
  });

  const hasAnomaly = events.some((e) => e.type === 'odometer_anomaly');
  const canDispute =
    ['escrow_pending', 'inspecting', 'inspection_accepted', 'handover_pending'].includes(deal.state) && !dispute;

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
      <Notice tone={dispute?.state === 'open' ? 'danger' : 'info'} title="Deal Protocol Status">
        {nextStep(deal, dispute, events)}
      </Notice>

      {msg ? <Notice tone={msg.tone} title={msg.text} /> : null}

      {/* Buyer: fund the escrow */}
      {deal.state === 'escrow_pending' && (
        <ActionCard
          title="Escrow Awaiting Funding"
          description={
            <>
              Two separate escrow legs: vehicle purchase funds {formatAmount(deal.priceAmount, deal.priceCurrency)} and
              inspection fee {formatAmount(deal.inspectionFeeAmount)}. Held separately until release conditions are met.
            </>
          }
        >
          <button
            className="primary w-full py-3"
            disabled={busy || !isBuyer}
            onClick={() =>
              act(
                () => post(`/api/deals/${deal.id}/fund`, { payerRef: deal.buyerId }, authHeaders()),
                'Escrow funded successfully. Deal locked.',
              )
            }
          >
            {isBuyer ? 'Fund Escrow Legs Now' : 'Only the designated buyer can fund this deal'}
          </button>
        </ActionCard>
      )}

      {/* Workshop: upload the report */}
      {deal.state === 'inspecting' && (
        <ActionCard
          title="Upload Workshop Inspection Report"
          description="Raw inspection files stay off-chain; cryptographic hashes are anchored on-chain."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="odo">Odometer Reading (km)</label>
              <input
                id="odo"
                inputMode="numeric"
                value={report.odometerKm}
                onChange={(e) => setReport({ ...report, odometerKm: e.target.value.replace(/[^0-9]/g, '') })}
                placeholder="30240"
              />
            </div>
            <div>
              <label htmlFor="inspectedAt">Physical Inspection Timestamp</label>
              <input
                id="inspectedAt"
                type="datetime-local"
                value={report.inspectedAt}
                onChange={(e) => setReport({ ...report, inspectedAt: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="reportHash">Report SHA256 Hash</label>
              <div className="flex gap-2">
                <input
                  id="reportHash"
                  value={report.reportHash}
                  onChange={(e) => setReport({ ...report, reportHash: e.target.value })}
                  placeholder="64 hex chars"
                />
                <button
                  type="button"
                  className="ghost whitespace-nowrap px-3 text-xs"
                  onClick={() => setReport({ ...report, reportHash: randomSha256() })}
                >
                  Generate
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="dashHash">Dashboard Photo SHA256</label>
              <div className="flex gap-2">
                <input
                  id="dashHash"
                  value={report.dashboardPhotoHash}
                  onChange={(e) => setReport({ ...report, dashboardPhotoHash: e.target.value })}
                  placeholder="64 hex chars"
                />
                <button
                  type="button"
                  className="ghost whitespace-nowrap px-3 text-xs"
                  onClick={() => setReport({ ...report, dashboardPhotoHash: randomSha256() })}
                >
                  Generate
                </button>
              </div>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="summary">Condition Summary Findings</label>
              <textarea
                id="summary"
                rows={3}
                value={report.conditionSummary}
                onChange={(e) => setReport({ ...report, conditionSummary: e.target.value })}
                placeholder="Physical findings on the inspection date — not a post-import warranty."
              />
            </div>
          </div>

          <fieldset className="mt-4 rounded-xl border border-line bg-subtle/50 p-4">
            <legend className="px-1 text-xs font-semibold text-ink uppercase tracking-wider">
              Standard Checklist Items
            </legend>
            <div className="grid gap-2.5 sm:grid-cols-2 mt-2">
              {Object.entries(report.checklist).map(([key, checked]) => (
                <label key={key} className="mb-0 flex items-center gap-2 text-xs text-body font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setReport({ ...report, checklist: { ...report.checklist, [key]: e.target.checked } })
                    }
                  />
                  <span>{key.replace(/_/g, ' ')}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <button
            className="primary mt-5 w-full py-3"
            disabled={
              busy ||
              !isInspector ||
              report.odometerKm === '' ||
              report.reportHash.length !== 64 ||
              report.dashboardPhotoHash.length !== 64
            }
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
                    authHeaders(),
                  ),
                'Report successfully uploaded and anchored.',
              )
            }
          >
            {isInspector ? 'Submit Inspection Report' : 'Only the selected workshop can upload report'}
          </button>
        </ActionCard>
      )}

      {/* Buyer: accept the report */}
      {deal.state === 'inspecting' && events.some((e) => e.type === 'report_uploaded') && (
        <ActionCard
          title="Review & Accept Inspection"
          description="Review findings before releasing inspection funds to the workshop."
        >
          {hasAnomaly ? (
            <div className="mb-4 space-y-3">
              <Notice tone="warn" title="Odometer Anomaly Detected on this Chassis">
                Recorded mileage is lower than historical events. Buyer acknowledgment is required before inspection funds release.
              </Notice>
              <label className="mb-0 flex items-center gap-2.5 text-xs text-body font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={accept.acknowledgeAnomaly}
                  onChange={(e) => setAccept({ acknowledgeAnomaly: e.target.checked })}
                />
                <span>I have reviewed and acknowledge the odometer anomaly warning</span>
              </label>
            </div>
          ) : null}

          <button
            className="primary w-full py-3"
            disabled={busy || !isBuyer || (hasAnomaly && !accept.acknowledgeAnomaly)}
            onClick={() =>
              act(async () => {
                const detail = await fetch(`/api/deals/${deal.id}`).then((r) => r.json());
                const reportId: string = detail.reports?.[0]?.id;
                if (!reportId) throw new Error('Report data is not yet synchronized');
                return post(
                  `/api/deals/${deal.id}/reports/${reportId}/accept`,
                  { buyerId: deal.buyerId, acknowledgeAnomaly: accept.acknowledgeAnomaly },
                  authHeaders(),
                );
              }, 'Report accepted. Inspection funds released to workshop.')
            }
          >
            {isBuyer ? 'Accept Report & Release Inspection Escrow' : 'Only the buyer can accept the report'}
          </button>
        </ActionCard>
      )}

      {/* Handover confirmation */}
      {['inspection_accepted', 'handover_pending'].includes(deal.state) && (
        <ActionCard
          title="Confirm Physical Handover"
          description={`Locked terms: ${deal.handoverTerms}. Confirmed parties: ${deal.handoverConfirmedBy.length}/2.`}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="method">Evidence Verification Method</label>
              <select
                id="method"
                value={handover.method}
                onChange={(e) => setHandover({ method: e.target.value as typeof handover.method })}
              >
                <option value="handover_location_confirmed">Location GPS Verified Handover</option>
                <option value="load_proof">Carrier Load Proof / Bill of Lading</option>
                <option value="mutual_confirmation">Mutual Buyer &amp; Seller Confirmation</option>
              </select>
            </div>
            <div className="flex items-end">
              <button
                className="ghost w-full py-2.5"
                disabled={busy || (!isBuyer && !isSeller)}
                onClick={() =>
                  act(
                    () =>
                      post(
                        `/api/deals/${deal.id}/handover`,
                        { actorId: actor?.id, method: handover.method },
                        authHeaders(),
                      ),
                    'Handover confirmation recorded in registry.',
                  )
                }
              >
                {isBuyer || isSeller ? 'Confirm Handover Execution' : 'Buyer or Seller only'}
              </button>
            </div>
          </div>
        </ActionCard>
      )}

      {/* Vehicle fund release */}
      {deal.state === 'handover_pending' && (
        <ActionCard
          title="Vehicle Escrow Release"
          description="Handover confirmed. Release purchase funds to seller and record the immutable Metaplex NFT completion receipt."
        >
          <button
            className="primary w-full py-3.5 text-base font-bold shadow-md"
            disabled={busy}
            onClick={() =>
              act(
                () => post(`/api/deals/${deal.id}/release-vehicle`, {}, authHeaders()),
                'Vehicle funds released. Completion receipt generated.',
              )
            }
          >
            Release Vehicle Funds &amp; Mint Receipt
          </button>
        </ActionCard>
      )}

      {/* Dispute */}
      {canDispute && (
        <ActionCard
          title="File Escrow Dispute"
          description="Freezes all escrow releases and receipt minting pending arbiter investigation."
        >
          <label htmlFor="reason">Dispute Ground &amp; Evidence</label>
          <textarea
            id="reason"
            rows={3}
            value={disputeForm.reason}
            onChange={(e) => setDisputeForm({ reason: e.target.value })}
            placeholder="Vehicle failed condition / seller failure to hand over chassis / fraudulent paperwork."
          />
          <button
            className="ghost mt-3 w-full border-rose-300 text-rose-700 hover:bg-rose-50"
            disabled={busy || !actor || disputeForm.reason.length < 10}
            onClick={() =>
              act(
                () =>
                  post(
                    `/api/deals/${deal.id}/disputes`,
                    { openedBy: actor?.id, reason: disputeForm.reason },
                    authHeaders(),
                  ),
                'Dispute opened. Escrows frozen.',
              )
            }
          >
            Submit Dispute &amp; Freeze Escrow
          </button>
        </ActionCard>
      )}

      {/* Arbiter */}
      {dispute?.state === 'open' && isArbiter && (
        <ActionCard title="Arbiter Resolution Ruling">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="outcome">Arbiter Ruling</label>
              <select
                id="outcome"
                value={resolveForm.outcome}
                onChange={(e) => setResolveForm({ ...resolveForm, outcome: e.target.value as typeof resolveForm.outcome })}
              >
                <option value="refund_buyer">Full Refund to Buyer</option>
                <option value="release_to_seller">Release Funds to Seller</option>
                <option value="split">Split Escrow Funds</option>
                <option value="bond_slashed">Seller at Fault: Slash Bond to Dispute Fund</option>
              </select>
            </div>
            {resolveForm.outcome === 'split' ? (
              <>
                <div>
                  <label htmlFor="toBuyer">Refund to Buyer Amount</label>
                  <input
                    id="toBuyer"
                    value={resolveForm.refundedAmount}
                    onChange={(e) => setResolveForm({ ...resolveForm, refundedAmount: e.target.value })}
                    placeholder="1000"
                  />
                </div>
                <div>
                  <label htmlFor="toSeller">Release to Seller Amount</label>
                  <input
                    id="toSeller"
                    value={resolveForm.releasedAmount}
                    onChange={(e) => setResolveForm({ ...resolveForm, releasedAmount: e.target.value })}
                    placeholder="44000"
                  />
                </div>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <label htmlFor="arbNote">Arbiter Formal Justification</label>
              <textarea
                id="arbNote"
                rows={3}
                value={resolveForm.arbiterNote}
                onChange={(e) => setResolveForm({ ...resolveForm, arbiterNote: e.target.value })}
              />
            </div>
          </div>
          <button
            className="primary mt-4 w-full py-3"
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
                    authHeaders(),
                  ),
                'Dispute resolved. Judgment executed.',
              )
            }
          >
            Execute Arbiter Judgment
          </button>
        </ActionCard>
      )}

      {dispute?.state === 'open' && !isArbiter ? (
        <Notice tone="danger" title={`Dispute Active (Opened by ${shortHash(dispute.openedBy, 8, 4)})`}>
          A dispute has frozen this deal. Sign in as designated arbiter to review evidence and rule.
        </Notice>
      ) : null}
    </div>
  );
}
