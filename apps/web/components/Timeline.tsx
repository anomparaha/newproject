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
      if (p.priceAmount) rows.push(['Harga diminta', formatAmount(p.priceAmount, p.priceCurrency)]);
      rows.push(['Foto (hash)', `${p.photoHashes?.length ?? 0} berkas`]);
      break;
    case 'listing_updated':
      rows.push(['Field diubah', Object.keys(p).filter((k) => p[k as keyof typeof p] !== undefined).join(', ') || '-']);
      break;
    case 'deal_committed':
      rows.push(['Pembeli', shortHash(p.buyerId, 10, 4)]);
      rows.push(['Bengkel dipilih', shortHash(p.selectedInspectorId, 10, 4)]);
      if (p.inspectionFeeAmount) rows.push(['Biaya inspeksi', formatAmount(p.inspectionFeeAmount, p.inspectionFeeCurrency)]);
      if (p.inspectionDeadline) rows.push(['Batas laporan', dateTime(p.inspectionDeadline)]);
      if (p.escrowRef) rows.push(['Escrow', shortHash(p.escrowRef, 14, 6)]);
      break;
    case 'report_uploaded':
      rows.push(['Odometer', p.odometerKm !== undefined ? `${p.odometerKm.toLocaleString('id-ID')} km` : '-']);
      if (p.reportHash) rows.push(['Hash laporan', shortHash(p.reportHash, 14, 8)]);
      if (p.dashboardPhotoHash) rows.push(['Hash foto dasbor', shortHash(p.dashboardPhotoHash, 14, 8)]);
      if (p.reportStandardVersion) rows.push(['Standar', p.reportStandardVersion]);
      break;
    case 'odometer_anomaly':
      if (p.anomaly) {
        rows.push(['Catatan sebelumnya', `${p.anomaly.previousOdometerKm.toLocaleString('id-ID')} km`]);
        rows.push(['Laporan sekarang', `${(p.odometerKm ?? 0).toLocaleString('id-ID')} km`]);
        rows.push(['Selisih', `${p.anomaly.deltaKm.toLocaleString('id-ID')} km`]);
      }
      break;
    case 'inspeksi_dana_lepas':
    case 'kendaraan_dana_lepas':
      if (p.amount) rows.push(['Dilepas', formatAmount(p.amount, p.currency)]);
      if (p.platformFeeAmount) rows.push(['Fee platform', formatAmount(p.platformFeeAmount, p.currency)]);
      if (p.payoutRef) rows.push(['Ref pembayaran', shortHash(p.payoutRef, 12, 6)]);
      break;
    case 'note_completed':
      if (p.priceAmount) rows.push(['Harga nota', formatAmount(p.priceAmount, p.priceCurrency)]);
      if (p.evidenceRoot) rows.push(['Root bukti', shortHash(p.evidenceRoot, 16, 10)]);
      if (p.escrowTxId) rows.push(['Tx escrow', shortHash(p.escrowTxId, 12, 6)]);
      rows.push(['NFT', p.noteAssetId ? shortHash(p.noteAssetId, 8, 6) : 'belum dicetak']);
      break;
    case 'dispute_opened':
      rows.push(['Alasan', p.reason ?? '-']);
      if (p.disputeId) rows.push(['ID sengketa', shortHash(p.disputeId, 10, 6)]);
      break;
    case 'dispute_resolved':
      rows.push(['Putusan', p.outcome ?? '-']);
      if (p.refundedAmount) rows.push(['Kembali ke pembeli', formatAmount(p.refundedAmount)]);
      if (p.releasedAmount) rows.push(['Dilepas ke penjual', formatAmount(p.releasedAmount)]);
      if (p.bondSlashedAmount) rows.push(['Jaminan terpotong', formatAmount(p.bondSlashedAmount)]);
      if (p.arbiterNote) rows.push(['Catatan arbiter', p.arbiterNote]);
      break;
    default:
      break;
  }
  return rows;
}

export function Timeline({ events, compact = false }: { events: VinEvent[]; compact?: boolean }) {
  if (events.length === 0) {
    return <p className="text-sm text-mist-400">Belum ada riwayat di platform untuk kendaraan ini.</p>;
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
