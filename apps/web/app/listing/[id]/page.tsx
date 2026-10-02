import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Notice, StateChip } from '@/components/Chips';
import { CommitDealForm } from '@/components/CommitDealForm';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await api.listing(id);
  if (!data) notFound();

  const { listing, seller, vinNotice } = data;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {listing.make} {listing.model} · {listing.year}
          </h1>
          <StateChip state={listing.status === 'listed' ? 'draft' : listing.status} />
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-mist-400">
          <span className="hash">{listing.vin}</span>
          <span>{listing.location}</span>
          <span>Dibuat {dateTime(listing.createdAt)}</span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <section className="card p-4">
            <h2 className="text-sm font-medium">Data yang dikunci listing</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Harga diminta</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatAmount(listing.priceAmount, listing.priceCurrency)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Odometer dicatat penjual</dt>
                <dd className="tabular-nums">{listing.odometerKm?.toLocaleString('id-ID') ?? '-'} km</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-mist-400">Syarat pengiriman</dt>
                <dd className="text-sm text-mist-300">{listing.shippingTerms}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-mist-400">Hash foto (isi file di luar chain)</dt>
                <dd className="mt-1 space-y-1">
                  {listing.photoHashes.map((hash, index) => (
                    <div key={hash} className="hash">
                      [{index + 1}] {hash}
                    </div>
                  ))}
                </dd>
              </div>
            </dl>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Penjual</h2>
            {seller ? (
              <div className="mt-2 space-y-1 text-sm">
                <div>{seller.displayName}</div>
                <div className="text-xs text-mist-400">
                  {seller.countryCode} · {seller.city ?? '-'} · verifikasi {seller.verification}
                </div>
                {seller.walletAddress ? <div className="hash mt-1">dompet {seller.walletAddress}</div> : null}
              </div>
            ) : (
              <p className="text-sm text-mist-400">Data penjual tidak tersedia.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <Link href={`/vin/${listing.vin}`} className="text-signal hover:underline">
                lihat rangkaian event VIN ini →
              </Link>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">Alur setelah deal dikunci</h2>
            <ol className="mt-3 space-y-2 text-sm text-mist-300">
              <li>1. Pembeli memilih bengkel, mengunci harga, batas waktu, dan siapa membayar ongkir.</li>
              <li>2. Dana kendaraan dan biaya inspeksi masuk escrow terpisah. Status listing menjadi reserved.</li>
              <li>3. Bengkel memeriksa unit di lokasi dan mengunggah laporan minimum (VIN cocok, foto dasbor, kilometer, kondisi utama, tanggal).</li>
              <li>4. Pembeli menerima atau menolak laporan dalam batas waktu. Anomali kilometer wajib terlihat.</li>
              <li>5. Dana kendaraan baru lepas setelah syarat serah terima terpenuhi. Nota dicatat ke pembeli.</li>
            </ol>
          </section>
        </div>

        <div className="space-y-6">
          <Notice tone="info" title="Batas nota digital">{vinNotice}</Notice>

          <div className="card p-4">
            <h2 className="text-sm font-medium">Jaminan & reputasi</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-mist-400">Jaminan listing</span>
                <span className="tabular-nums">{formatAmount(listing.bondAmount, listing.bondCurrency)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-mist-400">Status jaminan</span>
                <span className="chip text-safe border-safe/40">terkunci bila listing tayang</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-mist-400">ID listing</span>
                <span className="hash">{shortHash(listing.id, 12, 8)}</span>
              </div>
            </div>
            <p className="mt-3 text-xs text-mist-400">
              Jaminan membuat listing kosong lebih mahal daripada listing yang beres. Jaminan kembali bila deal bersih,
              terpotong bila listing palsu atau penjual menghilang.
            </p>
          </div>

          {listing.status === 'listed' ? (
            <CommitDealForm listing={listing} />
          ) : (
            <Notice tone="info" title="Listing tidak terbuka untuk deal baru">
              Status saat ini: {listing.status}. Listing yang sama tidak bisa dijual ke pembeli kedua selama escrow aktif.
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
