import Link from 'next/link';
import type { Listing } from '@vin/shared';
import { StateChip } from '@/components/Chips';
import { Icon } from '@/components/Icons';
import { VehiclePhoto } from '@/components/VehiclePhoto';
import { formatAmount } from '@/lib/format';

/**
 * Marketplace card with luxury/institutional design, clear specs,
 * pricing hierarchy, and seller bond collateral indicators.
 */
export function ListingCard({ listing, showVin = false }: { listing: Listing; showVin?: boolean }) {
  return (
    <article className="group card relative flex flex-col overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-pop hover:border-slate-400 bg-white border-slate-300">
      {/* Photo with overlay badges */}
      <div className="relative overflow-hidden bg-slate-900/5">
        <VehiclePhoto
          seed={listing.id}
          alt={`${listing.make} ${listing.model}`}
          className="h-52 w-full transition-transform duration-500 group-hover:scale-105"
          rounded="rounded-none"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/15 pointer-events-none" />

        <div className="absolute left-3 top-3">
          <span className="rounded-lg bg-white px-2.5 py-1 text-xs font-extrabold text-slate-900 shadow-sm border border-slate-200">
            {listing.year}
          </span>
        </div>

        <div className="absolute right-3 top-3">
          <StateChip state={listing.status} />
        </div>

        <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs text-white font-semibold">
          <span className="inline-flex items-center gap-1 drop-shadow-sm">
            <Icon name="pin" className="h-3.5 w-3.5 text-white" />
            {listing.location}
          </span>
          <span className="inline-flex items-center gap-1 drop-shadow-sm">
            <Icon name="gauge" className="h-3.5 w-3.5 text-white" />
            {listing.odometerKm?.toLocaleString('en-US') ?? '-'} km
          </span>
        </div>
      </div>

      {/* Details */}
      <div className="flex flex-1 flex-col p-5">
        <div className="space-y-1">
          <h3 className="text-lg font-bold leading-tight tracking-tight text-ink group-hover:text-slate-950 transition-colors">
            <Link href={`/listing/${listing.id}`} className="after:absolute after:inset-0 after:content-['']">
              {listing.make} {listing.model}
            </Link>
          </h3>
          <p className="text-xs text-muted truncate">
            {listing.shippingTerms ?? 'Standard corridor handover'}
          </p>
        </div>

        {showVin ? (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs">
            <span className="text-slate-600 font-bold uppercase tracking-wider text-[0.68rem]">Chassis VIN</span>
            <span className="hash font-bold text-slate-900">{listing.vin}</span>
          </div>
        ) : null}

        {/* Pricing & Bond breakdown */}
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[0.7rem] uppercase tracking-wider font-bold text-muted">Asking Price</div>
              <div className="text-xl font-extrabold tabular-nums tracking-tight text-slate-950">
                {formatAmount(listing.priceAmount, listing.priceCurrency)}
              </div>
            </div>
            <div className="text-right">
              <div className="inline-flex items-center gap-1 text-[0.7rem] uppercase tracking-wider font-bold text-muted">
                <Icon name="shield" className="h-3 w-3 text-emerald-700" />
                <span>Seller Bond</span>
              </div>
              <div className="text-sm font-bold tabular-nums text-emerald-800">
                {formatAmount(listing.bondAmount, listing.bondCurrency)}
              </div>
            </div>
          </div>
        </div>

        {/* Action bar */}
        <div className="mt-4 flex items-center justify-between pt-2">
          <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-900 group-hover:text-black">
            View Details
            <Icon name="arrow" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1" />
          </span>

          {showVin ? (
            <Link
              href={`/vin/${listing.vin}`}
              className="relative z-10 text-xs font-semibold text-muted hover:text-ink hover:underline"
            >
              Event Chain
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
