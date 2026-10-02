import Link from 'next/link';
import { api } from '@/lib/api';
import { Metric, Notice, StateChip } from '@/components/Chips';
import { dateTime, formatAmount, percent, relative } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [corridors, listings, tokenMetrics, policy] = await Promise.all([
    api.corridors(),
    api.listings(),
    api.tokenMetrics(),
    api.policy(),
  ]);

  const corridor = corridors?.corridors[0] ?? null;
  const metricsResult = corridor ? await api.corridorMetrics(corridor.id) : null;
  const metrics = metricsResult?.metrics ?? null;
  const halt = metricsResult?.halt ?? null;

  if (!listings || !policy) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Backend belum berjalan</h1>
        <Notice tone="warn" title="Jalankan API lalu halaman ini akan memuat data koridor">
          <code className="text-mist-300">npm run seed:reset</code> untuk mengisi data demo, lalu{' '}
          <code className="text-mist-300">npm run dev:api</code>.
        </Notice>
      </div>
    );
  }

  const liveListings = listings.listings.filter((l) => l.status !== 'completed');
  const completedNotes = listings.listings.filter((l) => l.status === 'completed').length;

  return (
    <div className="space-y-7">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Dasbor koridor {corridor ? `${corridor.originCountry} → ${corridor.destinationCountry}` : ''}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-mist-400">{policy.whatItIs}</p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Deal selesai" value={String(metrics?.dealsCompleted ?? 0)} hint="Metrik publik #1" />
        <Metric
          label="Median waktu sampai laporan"
          value={metrics?.medianHoursToReport !== null && metrics?.medianHoursToReport !== undefined ? `${metrics.medianHoursToReport} jam` : '-'}
          hint="Metrik publik #2"
        />
        <Metric label="Tingkat sengketa" value={percent(metrics?.disputeRate ?? 0, 1)} hint="Metrik publik #3" />
        <Metric label="Nota tercatat" value={String(completedNotes)} hint="Hanya untuk deal selesai" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Pemicu berhenti perluasan</h2>
          <p className="mt-1 text-xs text-mist-400">
            Jika keempat angka ini buruk sekaligus, perluasan dihentikan. Menambah utilitas token tidak memperbaiki pasar
            yang belum menyelesaikan kendaraan fisik.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Deal selesai rendah</span>
              <span className="tabular-nums text-mist-400">
                {metrics?.dealsCompleted ?? 0} / min {policy.haltThresholds.minDealsCompleted ?? '-'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Sengketa tinggi</span>
              <span className="tabular-nums text-mist-400">
                {percent(metrics?.disputeRate ?? 0, 1)} / maks {percent(policy.haltThresholds.maxDisputeRate ?? 0)}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Anomali kilometer belum dijelaskan</span>
              <span className="tabular-nums text-mist-400">
                {metrics?.unexplainedOdometerAnomalies ?? 0} / maks {policy.haltThresholds.maxUnexplainedAnomalies ?? '-'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Penjual / bengkel tidak kembali</span>
              <span className="tabular-nums text-mist-400">
                penjual {percent(metrics?.sellerReturnRate ?? 0)} · bengkel {percent(metrics?.inspectorReturnRate ?? 0)}
              </span>
            </li>
          </ul>
          <div className="mt-3">
            {halt?.halted ? (
              <Notice tone="danger" title="Perluasan dihentikan sementara">
                {(halt.reasons ?? []).join(', ')}
              </Notice>
            ) : (
              <Notice tone="info" title="Belum semua angka buruk sekaligus">
                Perluasan tetap ditahan sampai koridor pilot membuktikan deal selesai.
              </Notice>
            )}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">Jaminan yang terkunci (metrik token yang sah)</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(tokenMetrics?.lockBonds ?? []).map((bond) => (
              <div key={bond.currency} className="rounded-lg border border-ink-700 p-3">
                <div className="text-[0.68rem] uppercase tracking-wider text-mist-400">{bond.currency} terkunci</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(bond.amount)}</div>
              </div>
            ))}
            {(tokenMetrics?.lockBonds ?? []).length === 0 ? <p className="text-sm text-mist-400">Belum ada jaminan terkunci.</p> : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wider text-mist-400">Jaminan terpotong</dt>
              <dd className="tabular-nums">{tokenMetrics?.bondsSlashed ?? 0}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-mist-400">Jaminan kembali</dt>
              <dd className="tabular-nums">{tokenMetrics?.bondsReturned ?? 0}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-mist-400">{tokenMetrics?.note ?? policy.tokenMetricsNote}</p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Listing aktif</h2>
          <Link href="/listings" className="text-xs text-signal hover:underline">
            lihat semua
          </Link>
        </div>
        <div className="card overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th>Unit</th>
                <th>VIN</th>
                <th>Harga diminta</th>
                <th>Jaminan</th>
                <th>Status</th>
                <th>Diperbarui</th>
              </tr>
            </thead>
            <tbody>
              {liveListings.slice(0, 8).map((listing) => (
                <tr key={listing.id}>
                  <td>
                    <Link href={`/listing/${listing.id}`} className="hover:text-signal">
                      {listing.make} {listing.model} · {listing.year}
                    </Link>
                    <div className="text-xs text-mist-400">{listing.location}</div>
                  </td>
                  <td className="hash">{listing.vin}</td>
                  <td className="tabular-nums">{formatAmount(listing.priceAmount, listing.priceCurrency)}</td>
                  <td className="tabular-nums">{formatAmount(listing.bondAmount, listing.bondCurrency)}</td>
                  <td>
                    <StateChip state={listing.status === 'listed' ? 'draft' : listing.status} />
                  </td>
                  <td className="text-xs text-mist-400">{relative(listing.updatedAt)}</td>
                </tr>
              ))}
              {liveListings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-mist-400">
                    Belum ada listing aktif.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="border-t border-ink-800 pt-4 text-xs text-mist-400">
        Terakhir dibaca {dateTime(new Date().toISOString())} · {policy.disclaimers?.nftNotTitle}
      </footer>
    </div>
  );
}
