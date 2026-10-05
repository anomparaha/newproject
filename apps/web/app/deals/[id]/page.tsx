import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, Fact, Notice, StateChip } from '@/components/Chips';
import { DealActions } from '@/components/DealActions';
import { Icon } from '@/components/Icons';
import { Timeline } from '@/components/Timeline';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LEG_LABEL: Record<string, string> = { vehicle: 'Vehicle Purchase Funds', inspection: 'Workshop Inspection Fee' };

const PROGRESS = [
  { label: 'Escrow Funded', desc: 'Two-leg deposit' },
  { label: 'Physical Inspection', desc: 'Workshop on site' },
  { label: 'Report Accepted', desc: 'Buyer sign-off' },
  { label: 'Chassis Handover', desc: 'Delivery confirmation' },
  { label: 'Completed', desc: 'Receipt NFT recorded' },
];

const PROGRESS_INDEX: Record<string, number> = {
  escrow_pending: 0,
  inspecting: 1,
  inspection_accepted: 2,
  handover_pending: 3,
  completed: 4,
};

function DealProgress({ state }: { state: string }) {
  const current = PROGRESS_INDEX[state];
  const finished = state === 'completed';
  return (
    <ol className="grid grid-cols-2 md:grid-cols-5 gap-3" aria-label="Deal progress">
      {PROGRESS.map((item, index) => {
        const done = current !== undefined && (finished || index < current);
        const active = current !== undefined && !finished && index === current;
        return (
          <li
            key={item.label}
            className={`relative flex flex-col p-3 rounded-xl border transition-all ${
              active
                ? 'bg-slate-900 border-slate-950 text-white shadow-xs'
                : done
                  ? 'bg-emerald-50/80 border-emerald-300 text-slate-950'
                  : 'bg-white border-slate-300 text-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${
                  done
                    ? 'bg-emerald-600 text-white'
                    : active
                      ? 'bg-white text-slate-950 shadow-2xs font-extrabold'
                      : 'bg-slate-100 text-slate-600 border border-slate-200'
                }`}
              >
                {done ? <Icon name="check" className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span
                className={`text-[0.65rem] font-bold uppercase tracking-wider ${
                  done ? 'text-emerald-700' : active ? 'text-emerald-400' : 'text-slate-500'
                }`}
              >
                {done ? 'Complete' : active ? 'Active' : 'Pending'}
              </span>
            </div>
            <span className={`text-xs font-bold leading-tight ${active ? 'text-white' : 'text-slate-950'}`}>
              {item.label}
            </span>
            <span className={`text-[0.7rem] mt-0.5 ${active ? 'text-slate-300' : 'text-slate-600'}`}>{item.desc}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await api.deal(id);
  if (!data) notFound();

  const { deal, escrows, reports, dispute, note, parties, events } = data;

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink">Deal Console</h1>
            <StateChip state={deal.state} />
            {dispute ? <Badge tone="bad">Dispute Active ({dispute.state})</Badge> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted">
            <Link href={`/vin/${deal.vin}`} className="hash font-semibold text-brand-600 hover:underline">
              Chassis VIN: {deal.vin}
            </Link>
            <span>Deal ID: {shortHash(deal.id, 10, 6)}</span>
            <span>Created {dateTime(deal.createdAt)}</span>
            <span>Inspection SLA {dateTime(deal.inspectionDeadline)}</span>
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-3">
          <Link href={`/vin/${deal.vin}`} className="ghost text-xs py-2 px-3">
            View Chassis Event History
          </Link>
        </div>
      </header>

      {/* Progress Stepper */}
      <section className="card p-5 sm:p-6 bg-white shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted mb-4">
          Lifecycle Progression
        </div>
        {PROGRESS_INDEX[deal.state] !== undefined ? (
          <DealProgress state={deal.state} />
        ) : (
          <Notice
            tone={deal.state === 'frozen' ? 'danger' : 'info'}
            title={deal.state === 'frozen' ? 'Deal Frozen by Active Dispute' : 'Deal Cancelled'}
          >
            Escrow payouts and receipt generation are suspended.
          </Notice>
        )}
      </section>

      {/* 2-Column Console Layout */}
      <div className="grid gap-8 lg:grid-cols-[1.75fr_1fr]">
        <div className="space-y-8">
          {/* Escrow Legs (2-Leg Escrow) */}
          <section className="space-y-3">
            <h2 className="text-base font-bold text-ink">Two-Leg Escrow Contracts</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {escrows.map((escrow) => (
                <div key={escrow.id} className="card p-5 bg-white space-y-3 shadow-xs border-line">
                  <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5">
                    <span className="inline-flex items-center gap-2 text-xs font-bold text-ink">
                      <Icon name="lock" className="h-4 w-4 text-brand-600" />
                      {LEG_LABEL[escrow.leg] ?? escrow.leg}
                    </span>
                    <Badge tone={escrow.status === 'funded' ? 'ok' : escrow.status === 'frozen' ? 'bad' : 'neutral'}>
                      {escrow.status}
                    </Badge>
                  </div>
                  <div>
                    <div className="text-xs text-muted uppercase tracking-wider font-semibold">Locked Amount</div>
                    <div className="text-2xl font-extrabold tabular-nums tracking-tight text-ink mt-0.5">
                      {formatAmount(escrow.amount, escrow.currency)}
                    </div>
                  </div>
                  <div className="text-xs text-muted">
                    Provider: <span className="font-semibold text-ink">{escrow.provider}</span> ·{' '}
                    {escrow.fundedAt ? `Funded ${dateTime(escrow.fundedAt)}` : 'Awaiting deposit'}
                  </div>
                  <div className="rounded-lg bg-subtle p-2.5 text-[0.72rem] text-muted border border-line">
                    <span className="font-semibold text-ink">Release Condition: </span>
                    <span>
                      {(escrow.releaseTerms.vehicle.length > 0
                        ? escrow.releaseTerms.vehicle
                        : escrow.releaseTerms.inspection
                      ).join(', ')}
                    </span>
                  </div>
                  {escrow.txRef ? <div className="hash text-[0.7rem]">Tx: {escrow.txRef}</div> : null}
                </div>
              ))}
            </div>
          </section>

          {/* Economic Summary */}
          <section className="card p-6 bg-white space-y-4 shadow-xs">
            <h2 className="text-base font-bold text-ink">Commercial Terms Breakdown</h2>
            <dl className="grid gap-4 sm:grid-cols-4 rounded-xl border border-line bg-subtle/50 p-4">
              <Fact label="Agreed Vehicle Price">
                <span className="font-bold tabular-nums text-base text-ink">
                  {formatAmount(deal.priceAmount, deal.priceCurrency)}
                </span>
              </Fact>
              <Fact label="Freight & Shipping">
                <span className="font-bold tabular-nums text-ink">{formatAmount(deal.shippingAmount)}</span>{' '}
                <span className="text-xs text-muted font-normal">({deal.shippingPaidBy})</span>
              </Fact>
              <Fact label="Workshop Inspection Fee">
                <span className="font-bold tabular-nums text-ink">{formatAmount(deal.inspectionFeeAmount)}</span>
              </Fact>
              <Fact label="Handover Protocol">
                <span className="text-xs font-medium text-body">{deal.handoverTerms}</span>
              </Fact>
            </dl>
            <p className="text-xs leading-relaxed text-muted">
              Sellers and inspection workshops receive payouts in designated fiat or stablecoins. Completing deals never
              mandates speculative token exposure.
            </p>
          </section>

          {/* Timeline */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight text-ink">Event Log for this Chassis</h2>
              <span className="text-xs text-muted">Append-only audit trail</span>
            </div>
            <Timeline events={events} />
          </section>
        </div>

        {/* Right Column: Actions & Meta */}
        <div className="space-y-6">
          <DealActions deal={deal} dispute={dispute} events={events} />

          {/* Parties */}
          <section className="card p-5 bg-white shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Designated Counterparties</h2>
            <ul className="divide-y divide-line text-sm">
              <li className="flex items-center justify-between gap-2 py-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-xs font-bold text-white shadow-2xs">
                    B
                  </span>
                  <span className="text-xs font-semibold text-muted">Buyer</span>
                </div>
                <span className="font-semibold text-ink text-sm">
                  {parties.buyer?.displayName ?? shortHash(deal.buyerId)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 py-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-emerald-600 text-xs font-bold text-white shadow-2xs">
                    S
                  </span>
                  <span className="text-xs font-semibold text-muted">Seller</span>
                </div>
                <span className="font-semibold text-ink text-sm">
                  {parties.seller?.displayName ?? shortHash(deal.sellerId)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2 py-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-amber-50 text-xs font-bold text-amber-700">
                    W
                  </span>
                  <span className="text-xs font-semibold text-muted">Workshop</span>
                </div>
                <span className="font-semibold text-ink text-sm">
                  {parties.inspector?.displayName ?? shortHash(deal.inspectorId)}
                </span>
              </li>
            </ul>
            <p className="text-xs text-muted pt-1">
              Affiliated workshops are cryptographically excluded from inspecting associated dealer units.
            </p>
          </section>

          {/* Reports */}
          <section className="card p-5 bg-white shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-ink uppercase tracking-wider">Physical Inspection Evidence</h2>
            {reports.length === 0 ? (
              <p className="text-xs text-muted py-2">No inspection reports uploaded yet.</p>
            ) : (
              reports.map((report) => (
                <div key={report.id} className="space-y-2 rounded-xl border border-line bg-subtle/50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-base font-bold tabular-nums text-ink">
                      {report.odometerKm.toLocaleString('en-US')} km
                    </span>
                    {report.anomaly ? <Badge tone="bad">Odometer Anomaly</Badge> : <Badge tone="ok">Verified Normal</Badge>}
                  </div>
                  <p className="text-xs text-body leading-relaxed">{report.conditionSummary}</p>
                  <div className="hash text-[0.7rem]">Report: {report.reportHash}</div>
                  <div className="hash text-[0.7rem]">Dash Photo: {report.dashboardPhotoHash}</div>
                  <div className="text-[0.7rem] text-muted">
                    Standard: {report.standardVersion} · {dateTime(report.inspectedAt)}
                  </div>
                </div>
              ))
            )}
          </section>

          {/* Completion receipt */}
          {note ? (
            <section className="card p-5 bg-gradient-to-br from-white to-blue-50/40 border-brand-200 shadow-xs space-y-3">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-white">
                  <Icon name="receipt" className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-sm font-bold text-ink">Completion Receipt Anchored</h2>
                  <div className="text-[0.7rem] text-brand-700 font-semibold">Metaplex Core Compatible</div>
                </div>
              </div>

              <div className="space-y-1.5 pt-1">
                <div className="hash text-[0.7rem]">Evidence Root: {note.evidenceRoot}</div>
                <div className="hash text-[0.7rem]">Escrow Tx: {note.escrowTxId ?? '-'}</div>
              </div>

              <Link
                href={`/api/notes/${note.id}/metadata`}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-600 hover:text-brand-700"
              >
                <span>View On-Chain Receipt Metadata</span>
                <Icon name="arrow" className="h-3 w-3" />
              </Link>
            </section>
          ) : null}

          {/* Dispute details if present */}
          {dispute ? (
            <Notice tone="danger" title={`Dispute Case (${dispute.state})`}>
              <div>{dispute.reason}</div>
              {dispute.arbiterNote ? (
                <div className="mt-2 text-xs font-medium text-body border-t border-rose-200 pt-2">
                  Ruling: {dispute.outcome} — {dispute.arbiterNote}
                </div>
              ) : null}
            </Notice>
          ) : null}
        </div>
      </div>
    </div>
  );
}
