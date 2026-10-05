import Link from 'next/link';
import { api } from '@/lib/api';
import { Badge, Notice, SectionTitle, StateChip } from '@/components/Chips';
import { Icon, type IconName } from '@/components/Icons';
import { ListingCard } from '@/components/ListingCard';
import { dateTime, formatAmount, percent, relative } from '@/lib/format';
import { ScrollReveal } from '@/components/ScrollReveal';
import { AnimatedMetric } from '@/components/AnimatedMetric';

export const dynamic = 'force-dynamic';

const STEPS: Array<{ icon: IconName; title: string; text: string; badge: string }> = [
  {
    icon: 'car',
    title: 'VIN-Locked Listing',
    text: 'Make, model, year, location, and price are cryptographically anchored to one chassis number with a seller collateral bond.',
    badge: 'Step 01',
  },
  {
    icon: 'lock',
    title: 'Two-Leg Escrow',
    text: 'Vehicle funds and the inspection fee sit in separate escrows. No funds release to the seller until handover terms are proven.',
    badge: 'Step 02',
  },
  {
    icon: 'report',
    title: 'Physical Inspection',
    text: 'An independent certified workshop chosen by the buyer inspects on site and uploads a verifiable report with odometer proof.',
    badge: 'Step 03',
  },
  {
    icon: 'receipt',
    title: 'Receipt on Handover',
    text: 'Completed transactions receive an immutable receipt. Event history is strictly append-only: past records cannot be rewritten.',
    badge: 'Step 04',
  },
];

const SAFEGUARDS = [
  { title: 'Chassis-Locked VIN', desc: 'Listing tied to unique physical chassis' },
  { title: 'Two-Leg Escrow', desc: 'Vehicle and inspection funds held separately' },
  { title: 'Odometer Anomaly Watch', desc: 'Automated rollback detection across records' },
  { title: 'Metaplex Receipt NFT', desc: 'Immutable on-chain evidence root on completion' },
];

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
      <div className="mx-auto max-w-2xl space-y-4 py-16 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-50 text-amber-600">
          <Icon name="alert" className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Backend Service Unavailable</h1>
        <p className="text-sm text-muted">Start the API server to load corridor and listing data.</p>
        <div className="mt-4">
          <Notice tone="warn" title="Quick start instructions">
            Run <code>npm run seed:reset</code> to load demo vehicles, then <code>npm run dev:api</code>.
          </Notice>
        </div>
      </div>
    );
  }

  const liveListings = listings.listings.filter((l) => l.status !== 'completed');
  const openListings = listings.listings.filter((l) => l.status === 'listed');
  const completedNotes = listings.listings.filter((l) => l.status === 'completed').length;

  return (
    <div className="space-y-14">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-slate-300 bg-white p-8 sm:p-12 shadow-elevated">
        <div className="relative grid gap-10 lg:grid-cols-[1.3fr_1fr] lg:items-center">
          <ScrollReveal direction="up" delay={50} className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-slate-100 px-3.5 py-1 text-xs font-bold text-slate-900 shadow-2xs">
              <span className="h-2 w-2 rounded-full bg-emerald-600 beacon-dot" />
              <span>Proof Stage · Escrow &amp; Physical Inspection Enforced</span>
            </div>

            <h1 className="text-4xl font-extrabold leading-[1.12] tracking-tight text-ink sm:text-5xl lg:text-6xl">
              Cross-border vehicles,{' '}
              <span className="text-slate-900">
                inspected and escrowed.
              </span>
            </h1>

            <p className="max-w-xl text-base leading-relaxed text-body sm:text-lg">
              {policy.whatItIs}
            </p>

            {/* Quick Action Links */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link href="/listings" className="primary btn-press px-6 py-3.5 text-base shadow-sm">
                Browse Vehicles
                <Icon name="arrow" className="h-4 w-4" />
              </Link>
              <Link href="/policy" className="ghost btn-press px-6 py-3.5 text-base">
                How Escrow Works
              </Link>
              {corridor ? (
                <div className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800 shadow-2xs">
                  <Icon name="globe" className="h-4 w-4 text-slate-900" />
                  <span>
                    Pilot Corridor: {corridor.originCountry} → {corridor.destinationCountry}
                  </span>
                </div>
              ) : null}
            </div>
          </ScrollReveal>

          {/* Built-in safeguards card — High-Contrast Dark Security Console */}
          <ScrollReveal direction="left" delay={150}>
            <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 p-6 sm:p-7 text-white shadow-xl transition-all duration-300 hover:shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3.5">
                <div>
                  <div className="text-base font-bold text-white tracking-tight">Built-in Safeguards</div>
                  <div className="text-xs text-slate-400">Enforced on-chain &amp; by platform rules</div>
                </div>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-800 text-emerald-400 border border-slate-700">
                  <Icon name="shield" className="h-4 w-4" />
                </span>
              </div>

              <ul className="mt-4 space-y-3.5">
                {SAFEGUARDS.map((item) => (
                  <li key={item.title} className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30">
                      <Icon name="check" className="h-3 w-3" />
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-white">{item.title}</div>
                      <div className="text-xs text-slate-400">{item.desc}</div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-5 rounded-xl border border-slate-800 bg-slate-800/80 p-3 text-xs leading-relaxed text-slate-300 flex items-center gap-2.5">
                <Icon name="lock" className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="font-medium">Sellers post collateral bonds; buyers control inspection release.</span>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* Metrics with Animated Count-up and Scroll Reveal */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AnimatedMetric
          label="Deals Completed"
          value={String(metrics?.dealsCompleted ?? 0)}
          hint="Public metric #1 · Verified transfers"
          icon="check"
          delay={0}
        />
        <AnimatedMetric
          label="Median Time to Report"
          value={
            metrics?.medianHoursToReport !== null && metrics?.medianHoursToReport !== undefined
              ? `${metrics.medianHoursToReport}h`
              : '-'
          }
          hint="Public metric #2 · Workshop SLA"
          icon="report"
          delay={90}
        />
        <AnimatedMetric
          label="Dispute Rate"
          value={percent(metrics?.disputeRate ?? 0, 1)}
          hint="Public metric #3 · Dispute resolution"
          icon="shield"
          delay={180}
        />
        <AnimatedMetric
          label="Receipts Recorded"
          value={String(completedNotes)}
          hint="Completed units with claim trail"
          icon="receipt"
          delay={270}
        />
      </section>

      {/* How it works */}
      <ScrollReveal direction="up" delay={50} as="section" className="space-y-6">
        <SectionTitle
          title="How a Deal is Protected"
          description="Four cryptographic and physical checkpoints, enforced by protocol code rather than seller promises."
        />
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((step, index) => (
            <ScrollReveal
              key={step.title}
              direction="up"
              delay={index * 90}
              className="card group relative flex flex-col justify-between p-6 transition-all duration-300 hover:-translate-y-1.5 hover:shadow-elevated hover:border-slate-400 bg-white"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-slate-900 text-white shadow-2xs transition-transform duration-300 group-hover:scale-105">
                    <Icon name={step.icon} className="h-5 w-5" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700 bg-slate-100 border border-slate-200 rounded-md px-2 py-0.5">
                    {step.badge}
                  </span>
                </div>
                <h3 className="mt-5 text-base font-bold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{step.text}</p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </ScrollReveal>

      {/* Featured units */}
      <ScrollReveal direction="up" delay={50} as="section" className="space-y-6">
        <SectionTitle
          title="Featured Open Units"
          description="Chassis-verified listings ready for two-leg escrow and independent inspection."
          action={
            <Link
              href="/listings"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800 hover:text-black transition-colors"
            >
              <span>View all listings ({listings.listings.length})</span>
              <Icon name="arrow" className="h-3.5 w-3.5" />
            </Link>
          }
        />
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {openListings.slice(0, 3).map((listing, index) => (
            <ScrollReveal key={listing.id} direction="up" delay={index * 100}>
              <ListingCard listing={listing} showVin />
            </ScrollReveal>
          ))}
        </div>
        {openListings.length === 0 ? (
          <div className="card p-8 text-center text-sm text-muted">No open listings currently available.</div>
        ) : null}
      </ScrollReveal>

      {/* Trust & Transparency: Halt Triggers vs Locked Bonds */}
      <section className="grid gap-6 lg:grid-cols-2">
        <ScrollReveal direction="right" delay={50}>
          <div className="card p-6 sm:p-7 space-y-4 bg-white h-full shadow-xs">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-ink">Expansion Halt Triggers</h2>
                <p className="text-xs text-muted">Corridor safety circuit-breaker rules</p>
              </div>
              <Badge tone={halt?.halted ? 'bad' : 'ok'}>{halt?.halted ? 'Halted' : 'Normal Operation'}</Badge>
            </div>
            <p className="text-sm leading-relaxed text-muted">
              If platform risk metrics cross critical thresholds, expansion automatically halts. Market health precedes token utility.
            </p>

            <ul className="divide-y divide-line text-sm">
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-body font-medium">Deals completed vs minimum</span>
                <span className="tabular-nums font-semibold text-ink">
                  {metrics?.dealsCompleted ?? 0} / min {policy.haltThresholds.minDealsCompleted ?? '-'}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-body font-medium">Dispute rate vs ceiling</span>
                <span className="tabular-nums font-semibold text-ink">
                  {percent(metrics?.disputeRate ?? 0, 1)} / max {percent(policy.haltThresholds.maxDisputeRate ?? 0)}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-body font-medium">Unexplained odometer anomalies</span>
                <span className="tabular-nums font-semibold text-ink">
                  {metrics?.unexplainedOdometerAnomalies ?? 0} / max {policy.haltThresholds.maxUnexplainedAnomalies ?? '-'}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-body font-medium">Actor retention (sellers / workshops)</span>
                <span className="tabular-nums font-semibold text-ink">
                  {percent(metrics?.sellerReturnRate ?? 0)} · {percent(metrics?.inspectorReturnRate ?? 0)}
                </span>
              </li>
            </ul>

            <div className="pt-2">
              {halt?.halted ? (
                <Notice tone="danger" title="Corridor Expansion Halted">
                  {(halt.reasons ?? []).join(', ')}
                </Notice>
              ) : (
                <Notice tone="safe" title="Corridor Health Verified">
                  Metrics are within safe operating bounds. Physical deliveries in pilot corridor ongoing.
                </Notice>
              )}
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal direction="left" delay={100}>
          <div className="card p-6 sm:p-7 space-y-4 bg-white h-full shadow-xs">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div>
                <h2 className="text-base font-bold text-ink">Seller Collateral Bonds</h2>
                <p className="text-xs text-muted">Active staked funds securing open listings</p>
              </div>
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-white shadow-2xs">
                <Icon name="lock" className="h-4 w-4" />
              </span>
            </div>

            <p className="text-sm leading-relaxed text-muted">
              Transparent on-chain collateral: sellers must lock bonds before publishing. Bonds are slashed upon fraudulent listings.
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {(tokenMetrics?.lockBonds ?? []).map((bond) => (
                <div key={bond.currency} className="rounded-xl border border-slate-300 bg-slate-100/70 p-4">
                  <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">{bond.currency} Locked</div>
                  <div className="mt-1 text-2xl font-extrabold tabular-nums tracking-tight text-ink">
                    {formatAmount(bond.amount)}
                  </div>
                </div>
              ))}
              {(tokenMetrics?.lockBonds ?? []).length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-muted col-span-2">
                  No active collateral locked currently.
                </div>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt className="text-xs font-bold uppercase tracking-wider text-muted">Bonds Slashed</dt>
                <dd className="mt-1 text-xl font-black tabular-nums text-rose-700">{tokenMetrics?.bondsSlashed ?? 0}</dd>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <dt className="text-xs font-bold uppercase tracking-wider text-muted">Bonds Returned</dt>
                <dd className="mt-1 text-xl font-black tabular-nums text-emerald-700">{tokenMetrics?.bondsReturned ?? 0}</dd>
              </div>
            </dl>

            <p className="text-xs leading-relaxed text-muted pt-1">
              {tokenMetrics?.note ?? policy.tokenMetricsNote}
            </p>
          </div>
        </ScrollReveal>
      </section>

      {/* Active Listings Ledger Table */}
      <ScrollReveal direction="up" delay={50} as="section" className="space-y-6">
        <SectionTitle
          title="Active Listings Ledger"
          description="Live verified units recorded on the trade registry."
          action={
            <Link
              href="/listings"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-800 hover:text-black transition-colors"
            >
              <span>View full catalog</span>
              <Icon name="arrow" className="h-3.5 w-3.5" />
            </Link>
          }
        />
        <div className="card overflow-hidden bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Vehicle Unit</th>
                  <th>Chassis VIN</th>
                  <th>Asking Price</th>
                  <th>Seller Bond</th>
                  <th>Status</th>
                  <th>Last Update</th>
                </tr>
              </thead>
              <tbody>
                {liveListings.slice(0, 8).map((listing) => (
                  <tr key={listing.id}>
                    <td>
                      <Link href={`/listing/${listing.id}`} className="font-semibold text-ink hover:text-brand-600">
                        {listing.make} {listing.model} · {listing.year}
                      </Link>
                      <div className="text-xs text-muted">{listing.location}</div>
                    </td>
                    <td className="hash font-medium">{listing.vin}</td>
                    <td className="tabular-nums font-semibold text-ink">
                      {formatAmount(listing.priceAmount, listing.priceCurrency)}
                    </td>
                    <td className="tabular-nums font-medium text-emerald-700">
                      {formatAmount(listing.bondAmount, listing.bondCurrency)}
                    </td>
                    <td>
                      <StateChip state={listing.status} />
                    </td>
                    <td className="text-xs text-muted">{relative(listing.updatedAt)}</td>
                  </tr>
                ))}
                {liveListings.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">
                      No active listings found in ledger.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </ScrollReveal>

      {/* Footer disclaimers */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted border-t border-line pt-4">
        <Badge tone="neutral">Registry Sync: {dateTime(new Date().toISOString())}</Badge>
        <span className="italic">{policy.disclaimers?.nftNotTitle}</span>
      </div>
    </div>
  );
}
