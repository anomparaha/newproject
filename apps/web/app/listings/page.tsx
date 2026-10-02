import Link from 'next/link';
import { api } from '@/lib/api';
import { Notice, StateChip } from '@/components/Chips';
import { formatAmount } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ListingsPage() {
  const data = await api.listings();

  if (!data) {
    return <Notice tone="warn" title="API belum berjalan">Jalankan <code>npm run dev:api</code>.</Notice>;
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Listing</h1>
        <p className="text-sm text-mist-400">
          Listing mengunci merek, model, tahun, VIN, lokasi fisik, harga, syarat pengiriman, dan hash foto. Data ini belum
          menjadi nota selesai.
        </p>
      </header>

      <Notice tone="info" title="Batas hukum">
        VIN hanya unik di dalam platform. Format rangka berbeda antar negara, dan keunikan on-chain tidak sama dengan
        keunikan registrasi resmi.
      </Notice>

      <div className="card overflow-x-auto">
        <table className="ledger">
          <thead>
            <tr>
              <th>Unit</th>
              <th>VIN</th>
              <th>Lokasi</th>
              <th>Harga</th>
              <th>Jaminan listing</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.listings.map((listing) => (
              <tr key={listing.id}>
                <td>
                  <div className="font-medium">
                    {listing.make} {listing.model}
                  </div>
                  <div className="text-xs text-mist-400">{listing.year} · {listing.odometerKm?.toLocaleString('id-ID') ?? '-'} km</div>
                </td>
                <td className="hash">{listing.vin}</td>
                <td className="text-xs text-mist-300">{listing.location}</td>
                <td className="tabular-nums">{formatAmount(listing.priceAmount, listing.priceCurrency)}</td>
                <td className="tabular-nums">{formatAmount(listing.bondAmount, listing.bondCurrency)}</td>
                <td>
                  <StateChip state={listing.status === 'listed' ? 'draft' : listing.status} />
                </td>
                <td className="text-right">
                  <div className="flex justify-end gap-3 text-xs">
                    <Link href={`/listing/${listing.id}`} className="text-signal hover:underline">
                      detail
                    </Link>
                    <Link href={`/vin/${listing.vin}`} className="text-mist-400 hover:text-paper">
                      riwayat VIN
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {data.listings.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-mist-400">
                  Belum ada listing. Jalankan <code>npm run seed:reset</code>.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <section className="card p-4">
        <h2 className="text-sm font-medium">Koridor yang dilayani</h2>
        <p className="mt-1 text-xs text-mist-400">
          Koridor pertama sengaja sempit: satu negara asal dengan data rangka relatif rapi, satu negara tujuan, nilai
          kendaraan di atas ambang, inspeksi wajib.
        </p>
        <div className="mt-3 space-y-2 text-sm">
          {data.corridor ? (
            <div className="rounded-lg border border-safe/30 bg-safe/5 p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {data.corridor.originCountry} → {data.corridor.destinationCountry}
                </span>
                <span className="chip text-safe border-safe/40">{data.corridor.status}</span>
              </div>
              <div className="mt-1 text-xs text-mist-300">
                Ambang nilai USD {data.corridor.minVehiclePriceUsd.toLocaleString('id-ID')} · mata uang{' '}
                {data.corridor.allowedCurrencies.join(', ')} · inspeksi wajib
              </div>
            </div>
          ) : null}
          {data.candidateCorridors.map((candidate) => (
            <div key={`${candidate.originCountry}-${candidate.destinationCountry}`} className="rounded-lg border border-ink-700 p-3">
              <div className="flex items-center justify-between">
                <span>
                  {candidate.originCountry} → {candidate.destinationCountry}
                </span>
                <span className="chip text-mist-400">belum dilayani</span>
              </div>
              <div className="mt-1 text-xs text-mist-400">{candidate.reason}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
