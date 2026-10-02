import { api } from '@/lib/api';
import { Notice } from '@/components/Chips';
import { formatAmount } from '@/lib/format';

export const dynamic = 'force-dynamic';

const BPS_LABEL: Record<string, string> = {
  vehicleBps: 'Vehicle transaction fee (bps)',
  inspectionBps: 'Inspection app fee (bps)',
  tokenDiscountFactor: 'Fee discount factor when paid in token',
};

const BOND_LABEL: Record<string, string> = {
  listingBondUsdc: 'Listing bond (USDC)',
  inspectorBondUsdc: 'Workshop bond (USDC)',
  stablecoinAllowedBelowUsd: 'Stablecoin bond allowed below (USD)',
  slashRatio: 'Share of the bond slashed on a violation',
};

export default async function PolicyPage() {
  const policy = await api.policy();

  if (!policy) {
    return <Notice tone="warn" title="API is not running">Run <code>npm run dev:api</code>.</Notice>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Policy & stages</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-mist-400">{policy.whatItIs}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Notice tone="info" title="Money">{policy.moneyRule}</Notice>
        <Notice tone="warn" title="The NFT is not a title">{policy.disclaimers?.nftNotTitle}</Notice>
        <Notice tone="danger" title="The token is not equity">{policy.disclaimers?.tokenNotEquity}</Notice>
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Fees</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(policy.fees).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3">
                <span className="text-mist-300">{BPS_LABEL[key] ?? key}</span>
                <span className="tabular-nums text-mist-400">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">
            Actors without the token can still pay fees in stablecoin. Only the part of the fee that actually arrives as
            the token can be burned, and only once it has been collected from real usage — there is no scheduled burn.
          </p>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">Bonds</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {Object.entries(policy.bonds).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3">
                <span className="text-mist-300">{BOND_LABEL[key] ?? key}</span>
                <span className="tabular-nums text-mist-400">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">
            A bond is slashed when a listing is proven fake, a seller disappears, or a report fails the standard. The
            slashed amount goes to the dispute fund, never to the team wallet.
          </p>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-medium">The token: three functions, no more</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {policy.token.functions.map((fn) => (
              <li key={fn} className="flex items-center gap-2">
                <span className="text-safe">✓</span> {fn}
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs uppercase tracking-wider text-mist-400">Never</div>
          <ul className="mt-1 space-y-1 text-sm">
            {policy.token.neverDoes.map((fn) => (
              <li key={fn} className="flex items-center gap-2 text-mist-300">
                <span className="text-alert">✕</span> {fn}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-mist-400">{policy.tokenMetricsNote}</p>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-medium">Sequence before anything may be published</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-4">
          {policy.stages.map((stage) => (
            <div key={stage.id} className="rounded-lg border border-ink-700 p-3">
              <div className="text-sm font-medium">{stage.label}</div>
              <div className="mt-2 text-[0.68rem] uppercase tracking-wider text-safe">allowed</div>
              <ul className="mt-1 space-y-1 text-xs text-mist-300">
                {stage.allowed.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
              <div className="mt-2 text-[0.68rem] uppercase tracking-wider text-alert">not allowed</div>
              <ul className="mt-1 space-y-1 text-xs text-mist-400">
                {stage.forbidden.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="text-sm font-medium">Valid events</h2>
          <p className="mt-1 text-xs text-mist-400">
            Old events are never overwritten. Only the following events may enter a VIN's chain.
          </p>
          <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
            {policy.eventTypes.map((event) => (
              <li key={event.type} className="flex items-center justify-between gap-2 rounded border border-ink-800 px-2 py-1">
                <span className="text-mist-300">{event.label}</span>
                <span className="text-[0.68rem] uppercase tracking-wider text-mist-400">{event.category}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-medium">Controls that keep it healthy</h2>
            <ul className="mt-3 space-y-2 text-sm text-mist-300">
              <li>Vehicle funds do not release before handover conditions are met.</li>
              <li>Inspection funds do not release before a complete report.</li>
              <li>The seller does not choose the inspector.</li>
              <li>Old events cannot be edited.</li>
              <li>Odometer anomalies stay visible.</li>
              <li>A dispute freezes both the receipt and the escrow.</li>
              <li>Seller and workshop identities can be revoked.</li>
              <li>Every vehicle page states that this record is a claim trail, not a title.</li>
            </ul>
          </div>
          <div className="card p-4">
            <h2 className="text-sm font-medium">Expansion halt thresholds</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {Object.entries(policy.haltThresholds).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-3">
                  <span className="text-mist-300">{key}</span>
                  <span className="tabular-nums text-mist-400">{formatAmount(value)}</span>
                </li>
              ))}
            </ul>
          </div>
          <Notice tone="warn" title="Inspection reports">{policy.disclaimers?.reportNotWarranty}</Notice>
        </div>
      </section>
    </div>
  );
}
