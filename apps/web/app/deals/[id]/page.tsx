import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Notice, StateChip } from '@/components/Chips';
import { DealActions } from '@/components/DealActions';
import { Timeline } from '@/components/Timeline';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LEG_LABEL: Record<string, string> = { vehicle: 'Dana kendaraan', inspection: 'Dana inspeksi' };

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await api.deal(id);
  if (!data) notFound();

  const { deal, escrows, reports, dispute, note, parties, events } = data;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Konsol deal</h1>
          <StateChip state={deal.state} />
          {dispute ? <span className="chip text-alert border-alert/50">sengketa {dispute.state}</span> : null}
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-mist-400">
          <Link href={`/vin/${deal.vin}`} className="hash hover:text-signal">
            VIN {deal.vin}
          </Link>
          <span>deal {shortHash(deal.id, 10, 6)}</span>
          <span>dibuka {dateTime(deal.createdAt)}</span>
          <span>batas laporan {dateTime(deal.inspectionDeadline)}</span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2">
            {escrows.map((escrow) => (
              <div key={escrow.id} className="card p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{LEG_LABEL[escrow.leg] ?? escrow.leg}</span>
                  <span className={`chip ${escrow.status === 'funded' ? 'text-safe border-safe/40' : escrow.status === 'frozen' ? 'text-alert border-alert/50' : 'text-mist-300'}`}>
                    {escrow.status}
                  </span>
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums">{formatAmount(escrow.amount, escrow.currency)}</div>
                <div className="mt-1 text-xs text-mist-400">
                  penyedia {escrow.provider} · {escrow.fundedAt ? `didanai ${dateTime(escrow.fundedAt)}` : 'belum didanai'}
                </div>
                <div className="mt-2 text-xs text-mist-400">
                  syarat lepas: {(escrow.releaseTerms.vehicle.length > 0 ? escrow.releaseTerms.vehicle : escrow.releaseTerms.inspection).join(', ')}
                </div>
                {escrow.txRef ? <div className="hash mt-2">{escrow.txRef}</div> : null}
              </div>
            ))}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Ringkasan ekonomi</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-4 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Harga</dt>
                <dd className="tabular-nums">{formatAmount(deal.priceAmount, deal.priceCurrency)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Ongkir</dt>
                <dd className="tabular-nums">
                  {formatAmount(deal.shippingAmount)} <span className="text-mist-400">({deal.shippingPaidBy})</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Biaya inspeksi</dt>
                <dd className="tabular-nums">{formatAmount(deal.inspectionFeeAmount)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Syarat serah terima</dt>
                <dd className="text-xs text-mist-300">{deal.handoverTerms}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-mist-400">
              Penjual dan bengkel menerima stablecoin atau fiat. Mereka tidak dipaksa memegang token hanya karena
              pekerjaan selesai.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Rangkaian event VIN ini</h2>
            <Timeline events={events} />
          </section>
        </div>

        <div className="space-y-6">
          <DealActions deal={deal} dispute={dispute} events={events} />

          <section className="card p-4">
            <h2 className="text-sm font-medium">Pihak</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-center justify-between gap-2">
                <span className="text-mist-400">Pembeli</span>
                <span>{parties.buyer?.displayName ?? shortHash(deal.buyerId)}</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-mist-400">Penjual</span>
                <span>{parties.seller?.displayName ?? shortHash(deal.sellerId)}</span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-mist-400">Bengkel</span>
                <span>{parties.inspector?.displayName ?? shortHash(deal.inspectorId)}</span>
              </li>
            </ul>
            <p className="mt-3 text-xs text-mist-400">
              Penjual tidak memilih inspektor untuk unitnya sendiri; bengkel terafiliasi dengan penjual diblokir dari order ini.
            </p>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Laporan inspeksi</h2>
            {reports.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">Belum ada laporan.</p>
            ) : (
              reports.map((report) => (
                <div key={report.id} className="mt-3 space-y-2 rounded-lg border border-ink-700 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{report.odometerKm.toLocaleString('id-ID')} km</span>
                    {report.anomaly ? <span className="chip text-alert border-alert/50">anomali kilometer</span> : <span className="chip text-safe border-safe/40">normal</span>}
                  </div>
                  <p className="text-xs text-mist-300">{report.conditionSummary}</p>
                  <div className="hash">laporan {report.reportHash}</div>
                  <div className="hash">foto dasbor {report.dashboardPhotoHash}</div>
                  <div className="text-xs text-mist-400">
                    standar {report.standardVersion} · {dateTime(report.inspectedAt)}
                  </div>
                </div>
              ))
            )}
            <p className="mt-3 text-xs text-mist-400">
              Laporan adalah temuan pada tanggal inspeksi, bukan garansi sampai kendaraan tiba di negara pembeli.
            </p>
          </section>

          {note ? (
            <section className="card p-4">
              <h2 className="text-sm font-medium">Nota selesai</h2>
              <div className="mt-2 space-y-1 text-xs">
                <div className="hash">root bukti {note.evidenceRoot}</div>
                <div className="hash">tx escrow {note.escrowTxId ?? '-'}</div>
                <div className="text-mist-400">status {note.status} · NFT belum dicetak (tahap bukti)</div>
              </div>
              <Link href={`/api/notes/${note.id}/metadata`} className="mt-3 inline-block text-xs text-signal hover:underline">
                lihat metadata nota (kompatibel Metaplex Core) →
              </Link>
            </section>
          ) : null}

          {dispute ? (
            <Notice tone="danger" title={`Sengketa ${dispute.state}`}>
              {dispute.reason}
              {dispute.arbiterNote ? <div className="mt-2 text-mist-300">Putusan: {dispute.outcome} — {dispute.arbiterNote}</div> : null}
            </Notice>
          ) : null}
        </div>
      </div>
    </div>
  );
}
