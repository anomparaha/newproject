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
          <span>Created {dateTime(listing.createdAt)}</span>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <section className="card p-4">
            <h2 className="text-sm font-medium">What the listing locks</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Asking price</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatAmount(listing.priceAmount, listing.priceCurrency)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-mist-400">Odometer as recorded by the seller</dt>
                <dd className="tabular-nums">{listing.odometerKm?.toLocaleString('en-US') ?? '-'} km</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-mist-400">Shipping terms</dt>
                <dd className="text-sm text-mist-300">{listing.shippingTerms}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wider text-mist-400">Photo hashes (the files stay off-chain)</dt>
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
            <h2 className="text-sm font-medium">Seller</h2>
            {seller ? (
              <div className="mt-2 space-y-1 text-sm">
                <div>{seller.displayName}</div>
                <div className="text-xs text-mist-400">
                  {seller.countryCode} · {seller.city ?? '-'} · verification {seller.verification}
                </div>
                {seller.walletAddress ? <div className="hash mt-1">wallet {seller.walletAddress}</div> : null}
              </div>
            ) : (
              <p className="text-sm text-mist-400">Seller data is unavailable.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <Link href={`/vin/${listing.vin}`} className="text-signal hover:underline">
                view this VIN's event chain →
              </Link>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-medium">What happens after a deal is locked</h2>
            <ol className="mt-3 space-y-2 text-sm text-mist-300">
              <li>1. The buyer picks a workshop and locks the price, the deadline, and who pays shipping.</li>
              <li>2. Vehicle funds and the inspection fee enter separate escrows. The listing becomes reserved.</li>
              <li>3. The workshop inspects the unit on site and uploads the minimum report (VIN match, dashboard photo, odometer, main condition, date).</li>
              <li>4. The buyer accepts or rejects the report within the deadline. Any odometer anomaly must be visible.</li>
              <li>5. Vehicle funds release only once handover conditions are met. The receipt is recorded to the buyer.</li>
            </ol>
          </section>
        </div>

        <div className="space-y-6">
          <Notice tone="info" title="Limits of a digital receipt">{vinNotice}</Notice>

          <div className="card p-4">
            <h2 className="text-sm font-medium">Bond & reputation</h2>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-mist-400">Listing bond</span>
                <span className="tabular-nums">{formatAmount(listing.bondAmount, listing.bondCurrency)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-mist-400">Bond status</span>
                <span className="chip text-safe border-safe/40">locked while the listing is live</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-mist-400">Listing ID</span>
                <span className="hash">{shortHash(listing.id, 12, 8)}</span>
              </div>
            </div>
            <p className="mt-3 text-xs text-mist-400">
              A bond makes an empty listing more expensive than a real one. It comes back after a clean deal and is
              slashed when a listing is fake or the seller disappears.
            </p>
          </div>

          {listing.status === 'listed' ? (
            <CommitDealForm listing={listing} />
          ) : (
            <Notice tone="info" title="This listing is not open for new deals">
              Current status: {listing.status}. The same listing cannot be sold to a second buyer while an escrow is
              active.
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
