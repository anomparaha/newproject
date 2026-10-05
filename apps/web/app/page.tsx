import Link from 'next/link';
import { api } from '@/lib/api';
import { Metric, Notice, StateChip } from '@/components/Chips';
import { VehiclePhoto } from '@/components/VehiclePhoto';
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
        <h1 className="text-2xl font-semibold tracking-tight">Backend is not running</h1>
        <Notice tone="warn" title="Start the API and this page will load corridor data">
          Run <code className="text-mist-300">npm run seed:reset</code> to load demo data, then{' '}
          <code className="text-mist-300">npm run dev:api</code>.
        </Notice>
      </div>
    );
  }

  const liveListings = listings.listings.filter((l) => l.status !== 'completed');
  const openListings = listings.listings.filter((l) => l.status === 'listed');
  const completedNotes = listings.listings.filter((l) => l.status === 'completed').length;

  return (
    <div className="space-y-7">
      <header className="card relative overflow-hidden p-6">
        <div className="relative z-10 max-w-3xl space-y-3">
          <span className="chip border-signal/40 text-signal">Proof stage · escrow + inspection enforced</span>
          <h1 className="text-3xl font-semibold tracking-tight">
            Cross-border vehicles, inspected and escrowed
            {corridor ? <span className="text-mist-400"> — {corridor.originCountry} → {corridor.destinationCountry}</span> : null}
          </h1>
          <p className="text-sm leading-relaxed text-mist-300">{policy.whatItIs}</p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-mist-400">
            <span className="chip">VIN-locked listings</span>
            <span className="chip">Two-leg escrow</span>
            <span className="chip">Odometer anomaly watch</span>
            <span className="chip">Receipt NFTs on completion</span>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-signal/10 blur-3xl"
        />
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Deals completed" value={String(metrics?.dealsCompleted ?? 0)} hint="Public metric #1" />
        <Metric
          label="Median time to report"
          value={metrics?.medianHoursToReport !== null && metrics?.medianHoursToReport !== undefined ? `${metrics.medianHoursToReport}h` : '-'}
          hint="Public metric #2"
        />
        <Metric label="Dispute rate" value={percent(metrics?.disputeRate ?? 0, 1)} hint="Public metric #3" />
        <Metric label="Receipts recorded" value={String(completedNotes)} hint="Completed deals only" />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Expansion halt triggers</h2>
          <p className="mt-1 text-xs text-mist-400">
            If all four numbers go bad at once, expansion stops. Adding token utility does not fix a market that has not
            yet delivered physical vehicles.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Too few completed deals</span>
              <span className="tabular-nums text-mist-400">
                {metrics?.dealsCompleted ?? 0} / min {policy.haltThresholds.minDealsCompleted ?? '-'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Dispute rate too high</span>
              <span className="tabular-nums text-mist-400">
                {percent(metrics?.disputeRate ?? 0, 1)} / max {percent(policy.haltThresholds.maxDisputeRate ?? 0)}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Unexplained odometer anomalies</span>
              <span className="tabular-nums text-mist-400">
                {metrics?.unexplainedOdometerAnomalies ?? 0} / max {policy.haltThresholds.maxUnexplainedAnomalies ?? '-'}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-mist-300">Sellers / workshops not returning</span>
              <span className="tabular-nums text-mist-400">
                sellers {percent(metrics?.sellerReturnRate ?? 0)} · workshops {percent(metrics?.inspectorReturnRate ?? 0)}
              </span>
            </li>
          </ul>
          <div className="mt-3">
            {halt?.halted ? (
              <Notice tone="danger" title="Expansion is halted for now">
                {(halt.reasons ?? []).join(', ')}
              </Notice>
            ) : (
              <Notice tone="info" title="Not every number is bad at once">
                Expansion still waits until the pilot corridor proves it can complete deals.
              </Notice>
            )}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">Locked bonds (the honest token metrics)</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(tokenMetrics?.lockBonds ?? []).map((bond) => (
              <div key={bond.currency} className="rounded-lg border border-ink-700 p-3">
                <div className="text-[0.68rem] uppercase tracking-wider text-mist-400">{bond.currency} locked</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{formatAmount(bond.amount)}</div>
              </div>
            ))}
            {(tokenMetrics?.lockBonds ?? []).length === 0 ? <p className="text-sm text-mist-400">No bonds are locked yet.</p> : null}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wider text-mist-400">Bonds slashed</dt>
              <dd className="tabular-nums">{tokenMetrics?.bondsSlashed ?? 0}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wider text-mist-400">Bonds returned</dt>
              <dd className="tabular-nums">{tokenMetrics?.bondsReturned ?? 0}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-mist-400">{tokenMetrics?.note ?? policy.tokenMetricsNote}</p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Featured units</h2>
          <Link href="/listings" className="text-xs text-signal hover:underline">
            view all
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {openListings.slice(0, 3).map((listing) => (
            <Link
              key={listing.id}
              href={`/listing/${listing.id}`}
              className="card overflow-hidden transition-colors hover:border-ink-600"
            >
              <VehiclePhoto
                seed={listing.id}
                alt={`${listing.make} ${listing.model}`}
                className="h-40 w-full border-0"
                rounded="rounded-none"
              />
              <div className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium leading-tight">
                      {listing.make} {listing.model}
                    </div>
                    <div className="text-xs text-mist-400">
                      {listing.year} · {listing.odometerKm?.toLocaleString('en-US') ?? '-'} km
                    </div>
                  </div>
                  <StateChip state={listing.status === 'listed' ? 'draft' : listing.status} />
                </div>
                <div className="flex items-center justify-between border-t border-ink-800 pt-2">
                  <span className="text-sm font-semibold tabular-nums">
                    {formatAmount(listing.priceAmount, listing.priceCurrency)}
                  </span>
                  <span className="text-xs text-mist-400">{listing.location}</span>
                </div>
              </div>
            </Link>
          ))}
          {openListings.length === 0 ? <p className="text-sm text-mist-400">No open listings right now.</p> : null}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Active listings</h2>
          <Link href="/listings" className="text-xs text-signal hover:underline">
            view all
          </Link>
        </div>
        <div className="card overflow-x-auto">
          <table className="ledger">
            <thead>
              <tr>
                <th>Unit</th>
                <th>VIN</th>
                <th>Asking price</th>
                <th>Bond</th>
                <th>Status</th>
                <th>Updated</th>
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
                    No active listings.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="border-t border-ink-800 pt-4 text-xs text-mist-400">
        Last read {dateTime(new Date().toISOString())} · {policy.disclaimers?.nftNotTitle}
      </footer>
    </div>
  );
}
