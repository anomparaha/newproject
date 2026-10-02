import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { Timeline } from '@/components/Timeline';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function VinPage({ params }: { params: Promise<{ vin: string }> }) {
  const { vin } = await params;
  const data = await api.vin(vin);
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Riwayat kendaraan</h1>
        <div className="hash text-base">{data.vin}</div>
        <p className="text-sm text-mist-400">
          Satu VIN memiliki rangkaian event, bukan satu berkas yang diedit. Event lama tidak ditimpa.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Notice tone="info" title="Batas klaim">
          {data.claimsBoundary}
        </Notice>
        <Notice tone="warn" title="Batas keunikan VIN">
          {data.notice}
        </Notice>
        <div className="card p-4">
          <div className="text-xs uppercase tracking-wider text-mist-400">Catatan terakhir odometer</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {data.lastOdometer ? `${data.lastOdometer.km.toLocaleString('id-ID')} km` : 'belum ada'}
          </div>
          {data.anomalies.length > 0 ? (
            <div className="mt-2 text-xs text-alert">
              {data.anomalies.length} anomali kilometer tercatat. Anomali bukan penolakan otomatis, tetapi peringatan yang
              wajib dilihat pembeli sebelum dana dilepas.
            </div>
          ) : (
            <div className="mt-2 text-xs text-mist-400">Tidak ada anomali kilometer.</div>
          )}
        </div>
      </div>

      {data.ifNoData ? <Notice tone="info" title={data.ifNoData} /> : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Rangkaian event</h2>
          <Timeline events={data.events} />
        </section>

        <div className="space-y-6">
          <section className="card p-4">
            <h2 className="text-sm font-medium">Listing pada VIN ini</h2>
            {data.listings.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">Belum ada listing.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {data.listings.map((listing) => (
                  <li key={listing.id} className="rounded-lg border border-ink-700 p-3 text-sm">
                    <Link href={`/listing/${listing.id}`} className="hover:text-signal">
                      {listing.make} {listing.model} · {listing.year}
                    </Link>
                    <div className="mt-1 text-xs text-mist-400">
                      {formatAmount(listing.priceAmount, listing.priceCurrency)} · status {listing.status}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Laporan inspeksi</h2>
            {data.reports.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">Belum ada laporan.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.reports.map((report) => (
                  <li key={report.id} className="rounded-lg border border-ink-700 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">{report.odometerKm.toLocaleString('id-ID')} km</span>
                      {report.anomaly ? <span className="chip text-alert border-alert/50">anomali</span> : null}
                    </div>
                    <div className="hash mt-1">{shortHash(report.reportHash, 20, 12)}</div>
                    <div className="mt-1 text-mist-400">{dateTime(report.inspectedAt)} · standar {report.standardVersion}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Nota selesai</h2>
            {data.notes.length === 0 ? (
              <p className="mt-2 text-sm text-mist-400">Belum ada nota. Nota hanya dicatat untuk deal selesai.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {data.notes.map((note) => (
                  <li key={note.id} className="rounded-lg border border-ink-700 p-3 text-xs">
                    <div>{formatAmount(note.priceAmount, note.priceCurrency)}</div>
                    <div className="hash mt-1">root {shortHash(note.evidenceRoot, 20, 12)}</div>
                    <Link href={`/deals/${note.id.replace('note_', '')}`} className="hidden" />
                    <Link href={`/api/notes/${note.id}/metadata`} className="mt-1 inline-block text-signal hover:underline">
                      metadata nota →
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
