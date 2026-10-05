import type { VinEvent } from '@vin/shared';
import { EVENT_META } from '@vin/shared';
import { Badge, CategoryChip } from './Chips';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

const DOT: Record<string, string> = {
  agreement: 'bg-slate-900 ring-4 ring-slate-200',
  inspection: 'bg-amber-600 ring-4 ring-amber-100',
  funds: 'bg-emerald-600 ring-4 ring-emerald-100',
  note: 'bg-slate-700 ring-4 ring-slate-200',
  dispute: 'bg-rose-600 ring-4 ring-rose-100',
};

function facts(event: VinEvent): Array<[string, string]> {
  const p = event.payload;
  const rows: Array<[string, string]> = [];
  switch (event.type) {
    case 'listing_created':
      rows.push(['Vehicle Unit', `${p.make ?? '-'} ${p.model ?? '-'} ${p.year ?? ''}`.trim()]);
      if (p.priceAmount) rows.push(['Asking Price', formatAmount(p.priceAmount, p.priceCurrency)]);
      rows.push(['Photo SHA256 Hashes', `${p.photoHashes?.length ?? 0} files recorded`]);
      break;
    case 'listing_updated':
      rows.push(['Fields Updated', Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined).join(', ') || '-']);
      break;
    case 'deal_committed':
      rows.push(['Buyer Ref', shortHash(p.buyerId, 10, 4)]);
      rows.push(['Assigned Workshop', shortHash(p.selectedInspectorId, 10, 4)]);
      if (p.inspectionFeeAmount) rows.push(['Inspection Escrow', formatAmount(p.inspectionFeeAmount, p.inspectionFeeCurrency)]);
      if (p.inspectionDeadline) rows.push(['Report SLA Deadline', dateTime(p.inspectionDeadline)]);
      if (p.escrowRef) rows.push(['Escrow Reference', shortHash(p.escrowRef, 14, 6)]);
      break;
    case 'report_uploaded':
      rows.push(['Physical Odometer', p.odometerKm !== undefined ? `${p.odometerKm.toLocaleString('en-US')} km` : '-']);
      if (p.reportHash) rows.push(['Report SHA256', shortHash(p.reportHash, 14, 8)]);
      if (p.dashboardPhotoHash) rows.push(['Dash Photo SHA256', shortHash(p.dashboardPhotoHash, 14, 8)]);
      if (p.reportStandardVersion) rows.push(['Report Standard', p.reportStandardVersion]);
      break;
    case 'odometer_anomaly':
      if (p.anomaly) {
        rows.push(['Highest Prior Reading', `${p.anomaly.previousOdometerKm.toLocaleString('en-US')} km`]);
        rows.push(['Reported Reading', `${(p.odometerKm ?? 0).toLocaleString('en-US')} km`]);
        rows.push(['Mileage Anomaly Delta', `${p.anomaly.deltaKm.toLocaleString('en-US')} km`]);
      }
      break;
    case 'inspection_funds_released':
    case 'vehicle_funds_released':
      if (p.amount) rows.push(['Released Amount', formatAmount(p.amount, p.currency)]);
      if (p.platformFeeAmount) rows.push(['Protocol Fee', formatAmount(p.platformFeeAmount, p.currency)]);
      if (p.payoutRef) rows.push(['Payout Reference', shortHash(p.payoutRef, 12, 6)]);
      break;
    case 'note_completed':
      if (p.priceAmount) rows.push(['Receipt Amount', formatAmount(p.priceAmount, p.priceCurrency)]);
      if (p.evidenceRoot) rows.push(['Evidence Merkle Root', shortHash(p.evidenceRoot, 16, 10)]);
      if (p.escrowTxId) rows.push(['Escrow On-Chain Tx', shortHash(p.escrowTxId, 12, 6)]);
      rows.push(['Metaplex Core NFT', p.noteAssetId ? shortHash(p.noteAssetId, 8, 6) : 'Proof stage record']);
      break;
    case 'dispute_opened':
      rows.push(['Dispute Reason', p.reason ?? '-']);
      if (p.disputeId) rows.push(['Dispute Case ID', shortHash(p.disputeId, 10, 6)]);
      break;
    case 'dispute_resolved':
      rows.push(['Arbiter Outcome', p.outcome ?? '-']);
      if (p.refundedAmount) rows.push(['Refunded to Buyer', formatAmount(p.refundedAmount)]);
      if (p.releasedAmount) rows.push(['Released to Seller', formatAmount(p.releasedAmount)]);
      if (p.bondSlashedAmount) rows.push(['Bond Slashed to Fund', formatAmount(p.bondSlashedAmount)]);
      if (p.arbiterNote) rows.push(['Arbiter Formal Note', p.arbiterNote]);
      break;
    default:
      break;
  }
  return rows;
}

export function Timeline({ events, compact = false }: { events: VinEvent[]; compact?: boolean }) {
  if (events.length === 0) {
    return (
      <div className="card p-6 text-center text-sm text-muted">
        No recorded event chain on the platform for this vehicle yet.
      </div>
    );
  }

  return (
    <ol className="relative space-y-4 before:absolute before:bottom-3 before:left-[0.625rem] before:top-3 before:w-0.5 before:bg-line-strong">
      {events.map((event) => {
        const meta = EVENT_META[event.type];
        return (
          <li key={event.id} className="relative pl-9">
            <span
              className={`absolute left-[0.25rem] top-5 h-3.5 w-3.5 rounded-full ${
                DOT[event.category] ?? 'bg-muted'
              }`}
            />
            <div className="card p-4 sm:p-5 bg-white shadow-xs hover:border-slate-300 transition-colors">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold tabular-nums text-muted bg-subtle px-1.5 py-0.5 rounded">
                  #{event.seq}
                </span>
                <span className="text-sm font-bold text-ink">{meta?.label ?? event.type}</span>
                <CategoryChip category={event.category} />
                {event.anchorSignature ? (
                  <Badge tone="ok">On-Chain Anchored</Badge>
                ) : (
                  <Badge tone="neutral">Off-Chain Verified</Badge>
                )}
                <span className="ml-auto text-xs text-muted font-medium">{dateTime(event.createdAt)}</span>
              </div>

              {!compact && facts(event).length > 0 ? (
                <dl className="mt-3.5 grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 rounded-xl border border-line bg-subtle/50 p-3">
                  {facts(event).map(([label, value]) => (
                    <div key={label}>
                      <dt className="font-semibold text-muted uppercase tracking-wider text-[0.65rem]">{label}</dt>
                      <dd className="mt-0.5 break-all text-ink font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <div className="hash mt-3 border-t border-line pt-2 text-[0.7rem] flex items-center justify-between">
                <span>Event ID: {event.id}</span>
                {event.anchorSignature ? (
                  <span className="text-brand-600 font-mono">Sig: {shortHash(event.anchorSignature, 8, 6)}</span>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
