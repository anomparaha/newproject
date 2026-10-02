import type { VinEvent } from '@vin/shared';
import { EVENT_META } from '@vin/shared';
import { CategoryChip } from './Chips';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

function facts(event: VinEvent): Array<[string, string]> {
  const p = event.payload;
  const rows: Array<[string, string]> = [];
  switch (event.type) {
    case 'listing_created':
      rows.push(['Unit', `${p.make ?? '-'} ${p.model ?? '-'} ${p.year ?? ''}`.trim()]);
      if (p.priceAmount) rows.push(['Asking price', formatAmount(p.priceAmount, p.priceCurrency)]);
      rows.push(['Photos (hashes)', `${p.photoHashes?.length ?? 0} files`]);
      break;
    case 'listing_updated':
      rows.push(['Fields changed', Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined).join(', ') || '-']);
      break;
    case 'deal_committed':
      rows.push(['Buyer', shortHash(p.buyerId, 10, 4)]);
      rows.push(['Workshop selected', shortHash(p.selectedInspectorId, 10, 4)]);
      if (p.inspectionFeeAmount) rows.push(['Inspection fee', formatAmount(p.inspectionFeeAmount, p.inspectionFeeCurrency)]);
      if (p.inspectionDeadline) rows.push(['Report deadline', dateTime(p.inspectionDeadline)]);
      if (p.escrowRef) rows.push(['Escrow', shortHash(p.escrowRef, 14, 6)]);
      break;
    case 'report_uploaded':
      rows.push(['Odometer', p.odometerKm !== undefined ? `${p.odometerKm.toLocaleString('en-US')} km` : '-']);
      if (p.reportHash) rows.push(['Report hash', shortHash(p.reportHash, 14, 8)]);
      if (p.dashboardPhotoHash) rows.push(['Dashboard photo hash', shortHash(p.dashboardPhotoHash, 14, 8)]);
      if (p.reportStandardVersion) rows.push(['Standard', p.reportStandardVersion]);
      break;
    case 'odometer_anomaly':
      if (p.anomaly) {
        rows.push(['Highest recorded', `${p.anomaly.previousOdometerKm.toLocaleString('en-US')} km`]);
        rows.push(['Current report', `${(p.odometerKm ?? 0).toLocaleString('en-US')} km`]);
        rows.push(['Difference', `${p.anomaly.deltaKm.toLocaleString('en-US')} km`]);
      }
      break;
    case 'inspection_funds_released':
    case 'vehicle_funds_released':
      if (p.amount) rows.push(['Released', formatAmount(p.amount, p.currency)]);
      if (p.platformFeeAmount) rows.push(['Platform fee', formatAmount(p.platformFeeAmount, p.currency)]);
      if (p.payoutRef) rows.push(['Payout ref', shortHash(p.payoutRef, 12, 6)]);
      break;
    case 'note_completed':
      if (p.priceAmount) rows.push(['Receipt price', formatAmount(p.priceAmount, p.priceCurrency)]);
      if (p.evidenceRoot) rows.push(['Evidence root', shortHash(p.evidenceRoot, 16, 10)]);
      if (p.escrowTxId) rows.push(['Escrow tx', shortHash(p.escrowTxId, 12, 6)]);
      rows.push(['NFT', p.noteAssetId ? shortHash(p.noteAssetId, 8, 6) : 'not minted yet']);
      break;
    case 'dispute_opened':
      rows.push(['Reason', p.reason ?? '-']);
      if (p.disputeId) rows.push(['Dispute ID', shortHash(p.disputeId, 10, 6)]);
      break;
    case 'dispute_resolved':
      rows.push(['Ruling', p.outcome ?? '-']);
      if (p.refundedAmount) rows.push(['Back to the buyer', formatAmount(p.refundedAmount)]);
      if (p.releasedAmount) rows.push(['Released to the seller', formatAmount(p.releasedAmount)]);
      if (p.bondSlashedAmount) rows.push(['Bond slashed', formatAmount(p.bondSlashedAmount)]);
      if (p.arbiterNote) rows.push(['Arbiter note', p.arbiterNote]);
      break;
    default:
      break;
  }
  return rows;
}

export function Timeline({ events, compact = false }: { events: VinEvent[]; compact?: boolean }) {
  if (events.length === 0) {
    return <p className="text-sm text-mist-400">No history on the platform for this vehicle yet.</p>;
  }
  return (
    <ol className="relative space-y-3 border-l border-ink-700 pl-4">
      {events.map((event) => {
        const meta = EVENT_META[event.type];
        return (
          <li key={event.id} className="relative">
            <span className="absolute -left-[1.42rem] top-2 h-2 w-2 rounded-full bg-signal" />
            <div className="card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-mist-400">#{event.seq}</span>
                <span className="text-sm font-medium">{meta?.label ?? event.type}</span>
                <CategoryChip category={event.category} />
                <span className="text-xs text-mist-400">{dateTime(event.createdAt)}</span>
                {event.anchorSignature ? (
                  <span className="chip text-safe border-safe/40">anchored</span>
                ) : (
                  <span className="chip text-mist-400">off-chain</span>
                )}
              </div>
              {!compact && (
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  {facts(event).map(([label, value]) => (
                    <div key={label} className="flex gap-2">
                      <dt className="text-mist-400">{label}</dt>
                      <dd className="break-all text-mist-300">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="hash mt-2">{event.id}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
