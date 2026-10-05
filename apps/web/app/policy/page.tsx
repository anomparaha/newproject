import { api } from '@/lib/api';
import { Badge, Notice, PageHeader } from '@/components/Chips';
import { Icon } from '@/components/Icons';
import { formatAmount } from '@/lib/format';
import { ScrollReveal } from '@/components/ScrollReveal';

export const dynamic = 'force-dynamic';

const BPS_LABEL: Record<string, string> = {
  vehicleBps: 'Vehicle Transaction Escrow Fee (basis points)',
  inspectionBps: 'Inspection Application Fee (basis points)',
  tokenDiscountFactor: 'Token Protocol Discount Factor',
};

const BOND_LABEL: Record<string, string> = {
  listingBondUsdc: 'Listing Collateral Bond (USDC)',
  inspectorBondUsdc: 'Workshop Capacity Bond (USDC)',
  stablecoinAllowedBelowUsd: 'Fiat/Stablecoin Permitted Below (USD)',
  slashRatio: 'Proportion of Bond Slashed on Proven Fraud',
};

const CONTROLS = [
  'Vehicle purchase funds cannot release before physical handover conditions are verified.',
  'Workshop inspection funds cannot release prior to an uploaded, complete report.',
  'Sellers cannot select the inspection workshop for their own listed vehicles.',
  'Historical vehicle events are permanently immutable and append-only.',
  'Odometer rollbacks and anomalies remain permanently visible to subsequent buyers.',
  'An active dispute halts both escrow payouts and completion receipt generation.',
  'Revocation rules apply to fraudulent dealer and workshop entities.',
  'Every record explicitly establishes a claim trail, not a legal state registration title.',
];

export default async function PolicyPage() {
  const policy = await api.policy();

  if (!policy) {
    return (
      <Notice tone="warn" title="API server is not responding">
        Run <code>npm run dev:api</code> to inspect protocol policy parameters.
      </Notice>
    );
  }

  return (
    <div className="space-y-12">
      <ScrollReveal direction="up" delay={0}>
        <PageHeader
          eyebrow="Protocol Governance & Safety"
          title="Policy, Collateral & Staged Rollout"
          description={policy.whatItIs}
        />
      </ScrollReveal>

      {/* Disclaimers & Core Truths */}
      <div className="grid gap-6 lg:grid-cols-3">
        <ScrollReveal direction="up" delay={50} className="h-full">
          <Notice tone="info" title="Fiat & Stablecoin Settlement" tag="Settlement" className="h-full">
            {policy.moneyRule}
          </Notice>
        </ScrollReveal>
        <ScrollReveal direction="up" delay={120} className="h-full">
          <Notice tone="warn" title="Claim Trail Boundary" tag="Legal Scope" className="h-full">
            {policy.disclaimers?.nftNotTitle}
          </Notice>
        </ScrollReveal>
        <ScrollReveal direction="up" delay={190} className="h-full">
          <Notice tone="danger" title="Regulatory Notice" tag="Compliance" className="h-full">
            {policy.disclaimers?.tokenNotEquity}
          </Notice>
        </ScrollReveal>
      </div>

      {/* Fees, Bonds, and Token Scope */}
      <ScrollReveal direction="up" delay={50} as="section" className="grid gap-6 lg:grid-cols-3">
        <div className="card p-6 bg-white space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-base font-bold text-ink">Protocol Fee Structure</h2>
            <Badge tone="neutral">Standard</Badge>
          </div>
          <ul className="divide-y divide-line text-sm">
            {Object.entries(policy.fees).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3 py-3">
                <span className="text-body font-medium text-xs sm:text-sm">{BPS_LABEL[key] ?? key}</span>
                <span className="font-bold tabular-nums text-ink">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted pt-2 border-t border-line">
            Participants can settle entirely in fiat or stablecoins. Protocol fees burned are strictly limited to revenue
            actually collected from genuine usage.
          </p>
        </div>

        <div className="card p-6 bg-white space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-base font-bold text-ink">Collateral Bonds</h2>
            <Badge tone="ok">Protection</Badge>
          </div>
          <ul className="divide-y divide-line text-sm">
            {Object.entries(policy.bonds).map(([key, value]) => (
              <li key={key} className="flex items-start justify-between gap-3 py-3">
                <span className="text-body font-medium text-xs sm:text-sm">{BOND_LABEL[key] ?? key}</span>
                <span className="font-bold tabular-nums text-ink">{String(value)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted pt-2 border-t border-line">
            Bonds are slashed upon fraudulent listings, ghost inventory, or corrupt inspection reports. Slashed funds
            transfer into the communal dispute restitution fund.
          </p>
        </div>

        <div className="card p-6 bg-white space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <h2 className="text-base font-bold text-ink">Token Utility Constraints</h2>
            <Badge tone="brand">Strict Scope</Badge>
          </div>
          <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">Permitted Functions</div>
          <ul className="space-y-2 text-xs text-body">
            {policy.token.functions.map((fn) => (
              <li key={fn} className="flex items-start gap-2">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-600">
                  <Icon name="check" className="h-2.5 w-2.5" />
                </span>
                <span>{fn}</span>
              </li>
            ))}
          </ul>

          <div className="text-xs font-bold uppercase tracking-wider text-rose-700 pt-2 border-t border-line">
            Strictly Prohibited
          </div>
          <ul className="space-y-2 text-xs text-muted">
            {policy.token.neverDoes.map((fn) => (
              <li key={fn} className="flex items-start gap-2">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
                  <Icon name="x" className="h-2.5 w-2.5" />
                </span>
                <span>{fn}</span>
              </li>
            ))}
          </ul>
        </div>
      </ScrollReveal>

      {/* Sequential Rollout Stages */}
      <ScrollReveal direction="up" delay={50} as="section" className="space-y-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">Sequential Stage Prerequisites</h2>
          <p className="text-sm text-muted mt-0.5">
            Each subsequent stage unlocks only after the preceding stage demonstrates verifiable physical completion.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {policy.stages.map((stage, index) => (
            <div key={stage.id} className="card p-5 bg-white space-y-4 shadow-xs">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700">
                    0{index + 1}
                  </span>
                  <div className="text-sm font-bold text-ink">{stage.label}</div>
                </div>
                {index === 0 ? <Badge tone="ok">Current</Badge> : <Badge tone="neutral">Locked</Badge>}
              </div>

              <div>
                <div className="text-[0.65rem] font-bold uppercase tracking-wider text-emerald-700">Permitted</div>
                <ul className="mt-1.5 space-y-1.5 text-xs text-body">
                  {stage.allowed.map((item) => (
                    <li key={item} className="flex items-start gap-1.5">
                      <span className="text-emerald-600 font-bold">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-line pt-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-wider text-rose-700">Prohibited</div>
                <ul className="mt-1.5 space-y-1.5 text-xs text-muted">
                  {stage.forbidden.map((item) => (
                    <li key={item} className="flex items-start gap-1.5">
                      <span className="text-rose-500 font-bold">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </ScrollReveal>

      {/* Safety controls & valid events */}
      <ScrollReveal direction="up" delay={50} as="section" className="grid gap-6 lg:grid-cols-2">
        <div className="card p-6 bg-white space-y-4">
          <h2 className="text-base font-bold text-ink">Permitted Registry Event Schema</h2>
          <p className="text-xs text-muted leading-relaxed">
            Historical events are permanent and append-only. Only the following registered event types are valid for
            inclusion in a chassis timeline.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 pt-2">
            {policy.eventTypes.map((event) => (
              <div
                key={event.type}
                className="flex items-center justify-between gap-2 rounded-xl border border-line bg-subtle/50 px-3.5 py-2.5 text-xs"
              >
                <span className="font-semibold text-ink">{event.label}</span>
                <span className="capitalize text-muted font-medium">{event.category}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-6 bg-white space-y-4">
            <h2 className="text-base font-bold text-ink">Systemic Integrity Controls</h2>
            <ul className="space-y-2.5 text-xs text-body">
              {CONTROLS.map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-slate-900" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-6 bg-white space-y-4">
            <h2 className="text-base font-bold text-ink">Expansion Halt Trigger Thresholds</h2>
            <ul className="divide-y divide-line text-xs">
              {Object.entries(policy.haltThresholds).map(([key, value]) => (
                <li key={key} className="flex justify-between gap-3 py-2.5">
                  <span className="text-body font-medium">{key}</span>
                  <span className="font-bold tabular-nums text-ink">{formatAmount(value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </ScrollReveal>
    </div>
  );
}
