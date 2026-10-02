import { api } from '@/lib/api';
import { Metric, Notice } from '@/components/Chips';
import { percent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function CorridorsPage() {
  const corridors = await api.corridors();

  if (!corridors) {
    return <Notice tone="warn" title="API belum berjalan">Jalankan <code>npm run dev:api</code>.</Notice>;
  }

  const details = await Promise.all(
    corridors.corridors.map(async (corridor) => ({
      corridor,
      result: await api.corridorMetrics(corridor.id),
    })),
  );

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Koridor</h1>
        <p className="max-w-3xl text-sm text-mist-400">
          Koridor pertama sengaja sempit. Koridor baru dibuka hanya setelah tingkat deal selesai dan tingkat sengketa di
          koridor lama terkendali.
        </p>
      </header>

      {details.map(({ corridor, result }) => (
        <section key={corridor.id} className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">
              {corridor.originCountry} → {corridor.destinationCountry}
            </h2>
            <span className={`chip ${corridor.status === 'pilot' ? 'text-signal border-signal/40' : 'text-mist-300'}`}>{corridor.status}</span>
            <span className="text-xs text-mist-400">
              ambang nilai USD {corridor.minVehiclePriceUsd.toLocaleString('id-ID')} · {corridor.allowedCurrencies.join(', ')}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Deal selesai" value={String(result?.metrics.dealsCompleted ?? 0)} />
            <Metric
              label="Median waktu sampai laporan"
              value={result?.metrics.medianHoursToReport !== null && result?.metrics.medianHoursToReport !== undefined ? `${result.metrics.medianHoursToReport} jam` : '-'}
            />
            <Metric label="Tingkat sengketa" value={percent(result?.metrics.disputeRate ?? 0, 1)} />
            <Metric label="Anomali kilometer terbuka" value={String(result?.metrics.unexplainedOdometerAnomalies ?? 0)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="card p-4">
              <h3 className="text-sm font-medium">Kesehatan koridor</h3>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex justify-between">
                  <span className="text-mist-300">Penjual kembali</span>
                  <span className="tabular-nums">{percent(result?.metrics.sellerReturnRate ?? 0)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-mist-300">Bengkel kembali</span>
                  <span className="tabular-nums">{percent(result?.metrics.inspectorReturnRate ?? 0)}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-mist-300">Perluasan dihentikan?</span>
                  <span className={result?.halt.halted ? 'text-alert' : 'text-safe'}>
                    {result?.halt.halted ? 'ya' : 'tidak'}
                  </span>
                </li>
              </ul>
              {result?.halt.halted ? (
                <div className="mt-3 text-xs text-alert">Alasan: {result.halt.reasons.join(', ')}</div>
              ) : (
                <p className="mt-3 text-xs text-mist-400">
                  Perluasan tetap memerlukan koridor lama yang benar-benar berjalan - bukan hanya angka yang tidak buruk.
                </p>
              )}
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-medium">Metrik publik yang sah ditampilkan</h3>
              <p className="mt-2 text-xs text-mist-400">
                Deal selesai, waktu median sampai laporan, tingkat sengketa. Yang tidak boleh dipublikasi sebagai fakta:
                proyeksi harga token atau janji hasil untuk holder.
              </p>
              <p className="mt-3 text-xs text-mist-400">
                Anomali kilometer pada VIN koridor ini dihitung sebagai belum dijelaskan bila VIN-nya tidak pernah
                menyelesaikan sengketa.
              </p>
            </div>
          </div>
        </section>
      ))}

      <section className="card p-4">
        <h2 className="text-sm font-medium">Koridor kandidat (belum boleh dilayani)</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {corridors.candidateCorridors.map((candidate) => (
            <li key={`${candidate.originCountry}-${candidate.destinationCountry}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700 p-3">
              <span>
                {candidate.originCountry} → {candidate.destinationCountry}
              </span>
              <span className="text-xs text-mist-400">{candidate.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
