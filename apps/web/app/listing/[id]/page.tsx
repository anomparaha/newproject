import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, Fact, Notice, StateChip } from '@/components/Chips';
import { CommitDealForm } from '@/components/CommitDealForm';
import { Icon } from '@/components/Icons';
import { VehiclePhoto } from '@/components/VehiclePhoto';
import { dateTime, formatAmount, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

const AFTER_LOCK = [
  {
    step: 1,
    title: 'Terms & Workshop Locked',
    text: 'The buyer selects a certified workshop, locking vehicle price, inspection deadline, and shipping liability.',
  },
  {
    step: 2,
    title: 'Two-Leg Escrow Funded',
    text: 'Vehicle purchase funds and the workshop inspection fee enter separate escrow smart contracts. Unit is reserved.',
  },
  {
    step: 3,
    title: 'Physical Workshop Inspection',
    text: 'The workshop inspects the physical chassis on-site and uploads the standardized report (VIN match, dash photo, odometer, condition).',
  },
  {
    step: 4,
    title: 'Report Approval / Dispute',
    text: 'The buyer reviews and accepts or disputes the report. Any odometer anomaly is highlighted for explicit buyer sign-off.',
  },
  {
    step: 5,
    title: 'Handover & Receipt NFT',
    text: 'Vehicle funds release only upon confirmed handover terms. An append-only completion receipt is recorded for the buyer.',
  },
];

export default async function ListingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await api.listing(id);
  if (!data) notFound();

  const { listing, seller, vinNotice } = data;

  return (
    <div className="space-y-8">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted">
        <Link href="/" className="hover:text-brand-600 transition-colors">
          Home
        </Link>
        <span>/</span>
        <Link href="/listings" className="hover:text-brand-600 transition-colors">
          Listings
        </Link>
        <span>/</span>
        <span className="font-medium text-ink truncate max-w-xs sm:max-w-md">
          {listing.make} {listing.model} ({listing.year})
        </span>
      </nav>

      {/* Main Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-line pb-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight text-ink sm:text-4xl">
              {listing.make} {listing.model} · {listing.year}
            </h1>
            <StateChip state={listing.status} />
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5 font-medium text-body">
              <Icon name="pin" className="h-4 w-4 text-brand-600" />
              {listing.location}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Icon name="gauge" className="h-4 w-4 text-brand-600" />
              {listing.odometerKm?.toLocaleString('en-US') ?? '-'} km
            </span>
            <span>Recorded {dateTime(listing.createdAt)}</span>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Chassis VIN:</span>
            <span className="hash font-mono font-semibold text-ink bg-subtle px-2 py-0.5 rounded-md">
              {listing.vin}
            </span>
          </div>
        </div>

        <div className="shrink-0 flex sm:flex-col sm:items-end gap-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted">Asking Price</div>
          <div className="text-3xl font-extrabold tabular-nums tracking-tight text-ink">
            {formatAmount(listing.priceAmount, listing.priceCurrency)}
          </div>
        </div>
      </header>

      {/* 2-Column Layout */}
      <div className="grid gap-8 lg:grid-cols-[1.75fr_1fr]">
        {/* Left Column: Photos, Locked Terms, Seller, Workflow */}
        <div className="space-y-8">
          {/* Photos */}
          <section className="card overflow-hidden bg-white shadow-xs">
            <VehiclePhoto
              seed={listing.id}
              alt={`${listing.make} ${listing.model}`}
              className="h-72 w-full sm:h-[28rem]"
              rounded="rounded-none"
            />
            <div className="grid gap-3 p-4 sm:grid-cols-3 bg-subtle/40 border-t border-line">
              <VehiclePhoto
                seed={`${listing.id}-b`}
                alt={`${listing.make} ${listing.model} side view (placeholder)`}
                className="h-28 w-full"
                rounded="rounded-xl"
                badge={false}
              />
              <VehiclePhoto
                seed={`${listing.id}-c`}
                alt={`${listing.make} ${listing.model} interior view (placeholder)`}
                className="h-28 w-full"
                rounded="rounded-xl"
                badge={false}
              />
              <VehiclePhoto
                seed={`${listing.id}-d`}
                alt={`${listing.make} ${listing.model} detail view (placeholder)`}
                className="h-28 w-full"
                rounded="rounded-xl"
                badge={false}
              />
            </div>
            <div className="border-t border-line px-5 py-3 text-xs leading-relaxed text-muted bg-white">
              Photos shown are deterministic visual representations. This listing records cryptographic photo SHA256 hashes
              to guarantee off-chain visual evidence integrity.
            </div>
          </section>

          {/* Locked Parameters */}
          <section className="card p-6 sm:p-7 space-y-5 bg-white">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <h2 className="text-lg font-bold text-ink">Locked Listing Specifications</h2>
              <Badge tone="brand">Immutable Terms</Badge>
            </div>

            <dl className="grid gap-6 sm:grid-cols-2">
              <Fact label="Chassis Number (VIN)">
                <span className="hash font-semibold text-ink text-sm">{listing.vin}</span>
              </Fact>
              <Fact label="Seller Odometer Declaration">
                <span className="tabular-nums font-semibold text-ink">
                  {listing.odometerKm?.toLocaleString('en-US') ?? '-'} km
                </span>
              </Fact>
              <Fact label="Shipping & Delivery Terms" className="sm:col-span-2">
                <span className="text-body font-medium">{listing.shippingTerms}</span>
              </Fact>
              <Fact label="Cryptographic Photo Hashes (Off-Chain Evidence)" className="sm:col-span-2">
                <div className="mt-1 space-y-2 rounded-xl border border-line bg-subtle p-3.5">
                  {listing.photoHashes.map((hash, index) => (
                    <div key={hash} className="flex items-center gap-2 hash">
                      <span className="font-bold text-muted">[{index + 1}]</span>
                      <span className="text-body font-mono">{hash}</span>
                    </div>
                  ))}
                </div>
              </Fact>
            </dl>
          </section>

          {/* Seller Card */}
          <section className="card p-6 sm:p-7 space-y-4 bg-white">
            <h2 className="text-lg font-bold text-ink">Verified Seller Profile</h2>
            {seller ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-line bg-subtle/50 p-4">
                <div className="flex items-center gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-lg font-bold text-white shadow-xs">
                    {seller.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <div className="font-bold text-ink text-base">{seller.displayName}</div>
                    <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
                      <span>
                        {seller.city ?? '-'}, {seller.countryCode}
                      </span>
                      <span>·</span>
                      <Badge tone="ok">{seller.verification}</Badge>
                    </div>
                  </div>
                </div>

                <div className="sm:text-right">
                  <div className="text-xs text-muted">Seller Wallet Address</div>
                  <div className="hash font-semibold text-ink text-xs mt-0.5">
                    {seller.walletAddress ? shortHash(seller.walletAddress, 8, 6) : 'Not connected'}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">Seller information is unavailable.</p>
            )}

            <div className="pt-2">
              <Link
                href={`/vin/${listing.vin}`}
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-600 hover:text-brand-700"
              >
                <span>View Full Append-Only Event Chain for this VIN</span>
                <Icon name="arrow" className="h-4 w-4" />
              </Link>
            </div>
          </section>

          {/* What happens after a deal is locked */}
          <section className="card p-6 sm:p-7 space-y-5 bg-white">
            <h2 className="text-lg font-bold text-ink">Escrow Workflow Sequence</h2>
            <div className="space-y-4">
              {AFTER_LOCK.map((item) => (
                <div key={item.step} className="flex gap-4 items-start">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-50 text-xs font-bold text-brand-700 ring-1 ring-brand-200/60">
                    0{item.step}
                  </span>
                  <div className="space-y-1 pt-0.5">
                    <h3 className="text-sm font-bold text-ink">{item.title}</h3>
                    <p className="text-sm leading-relaxed text-body">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Right Column: Escrow Form, Bond Details, Boundary notices */}
        <aside className="space-y-6">
          {/* Financial summary card */}
          <div className="card p-6 bg-white shadow-xs space-y-4">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">Vehicle Price</div>
              <div className="mt-1 text-3xl font-extrabold tabular-nums tracking-tight text-ink">
                {formatAmount(listing.priceAmount, listing.priceCurrency)}
              </div>
            </div>

            <dl className="space-y-3 border-t border-line pt-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted font-medium">Seller Collateral Bond</dt>
                <dd className="font-bold tabular-nums text-emerald-700">
                  {formatAmount(listing.bondAmount, listing.bondCurrency)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted font-medium">Bond Status</dt>
                <dd>
                  <Badge tone="ok">Staked in Contract</Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted font-medium">Listing ID</dt>
                <dd className="hash font-medium">{shortHash(listing.id, 10, 6)}</dd>
              </div>
            </dl>

            <div className="rounded-xl bg-subtle p-3 text-xs leading-relaxed text-muted border border-line">
              Collateral bonds prevent fake inventory and ghost listings. Clean completion releases the bond; seller fraud
              slashes it directly to the dispute fund.
            </div>
          </div>

          {/* Escrow Commit Form */}
          {listing.status === 'listed' ? (
            <CommitDealForm listing={listing} />
          ) : (
            <Notice tone="info" title="Listing Currently Locked">
              Status: {listing.status}. This unit is currently committed in active escrow and cannot be reserved by another buyer.
            </Notice>
          )}

          {/* Legal Boundary Notice */}
          <Notice tone="warn" title="Digital Receipt Boundary">
            {vinNotice}
          </Notice>
        </aside>
      </div>
    </div>
  );
}
