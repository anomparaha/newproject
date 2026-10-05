import Link from 'next/link';
import { Icon } from '@/components/Icons';

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-300 bg-white mt-16">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {/* Brand */}
        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-slate-900 text-white shadow-xs">
              <Icon name="shield" className="h-5 w-5" />
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-bold tracking-tight text-ink">VIN</span>
              <span className="text-xs font-bold text-slate-900">PROTOCOL</span>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted">
            Institutional cross-border vehicle marketplace. Chassis-locked listings, two-leg escrow, mandatory physical
            inspection, and immutable completion receipts.
          </p>
          <div className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
            <Icon name="lock" className="h-3.5 w-3.5 text-slate-900" />
            <span>Solana Anchor Escrow Program</span>
          </div>
        </div>

        {/* Marketplace */}
        <div>
          <div className="text-sm font-bold uppercase tracking-wider text-ink">Marketplace</div>
          <ul className="mt-4 space-y-2.5 text-sm text-muted">
            <li>
              <Link href="/listings" className="transition-colors hover:text-slate-950 font-medium">
                Vehicle Listings
              </Link>
            </li>
            <li>
              <Link href="/inspectors" className="transition-colors hover:text-slate-950 font-medium">
                Verified Workshops
              </Link>
            </li>
            <li>
              <Link href="/corridors" className="transition-colors hover:text-slate-950 font-medium">
                Trade Corridors
              </Link>
            </li>
            <li>
              <Link href="/policy" className="transition-colors hover:text-slate-950 font-medium">
                Policy &amp; Halt Triggers
              </Link>
            </li>
          </ul>
        </div>

        {/* Safeguards */}
        <div>
          <div className="text-sm font-bold uppercase tracking-wider text-ink">Platform Protections</div>
          <ul className="mt-4 space-y-2.5 text-sm text-body font-medium">
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              <span>Two-Leg Escrow Architecture</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              <span>Seller Collateral Bonds</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              <span>Odometer Anomaly Detection</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              <span>Metaplex Receipt NFT Metadata</span>
            </li>
          </ul>
        </div>

        {/* Current stage */}
        <div className="space-y-3 rounded-2xl border border-slate-300 bg-slate-50 p-5">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-700">Network Status</div>
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-900 shadow-2xs">
            <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
            Proof Stage · Pilot Active
          </div>
          <p className="text-xs leading-relaxed text-muted">
            Mandatory inspection &amp; escrow. Receipts recorded only for completed physical deliveries. Zero public token sale.
          </p>
        </div>
      </div>

      <div className="border-t border-slate-200 bg-slate-100/70">
        <div className="mx-auto flex max-w-7xl flex-col sm:flex-row items-center justify-between gap-4 px-4 py-4 text-xs text-muted sm:px-6 lg:px-8">
          <p>
            A VIN record is an append-only claim trail, not a legal vehicle title. Receipt NFTs are not legal titles and the token is not equity.
          </p>
          <div className="shrink-0 font-mono text-[0.7rem] text-slate-700 font-semibold">
            VIN Protocol © {new Date().getFullYear()}
          </div>
        </div>
      </div>
    </footer>
  );
}
