import { api } from '@/lib/api';
import { Badge, EmptyState, Notice, PageHeader } from '@/components/Chips';
import { formatAmount, percent } from '@/lib/format';
import { Icon } from '@/components/Icons';
import { ScrollReveal } from '@/components/ScrollReveal';

export const dynamic = 'force-dynamic';

export default async function InspectorsPage() {
  const data = await api.inspectors();

  if (!data) {
    return (
      <Notice tone="warn" title="API server is not responding">
        Run <code>npm run dev:api</code> to load verified inspection workshops.
      </Notice>
    );
  }

  return (
    <div className="space-y-8">
      <ScrollReveal direction="up" delay={0}>
        <PageHeader
          eyebrow="Independent Inspection Market"
          title="Verified Automotive Workshops"
          description="Workshops register coverage area, service capability, and post a capacity collateral bond. Buyers select the workshop independently; the fee stays in escrow until an authenticated physical report is delivered."
          actions={<Badge tone="brand">{data.inspectors.length} Certified Workshops</Badge>}
        />
      </ScrollReveal>

      <div className="grid gap-6 sm:grid-cols-2">
        <ScrollReveal direction="up" delay={50} className="h-full">
          <Notice tone="warn" title="Merit-Based Ranking Policy" tag="Integrity SLA" className="h-full">
            Ranking is determined strictly by on-time report SLA, dispute resolution track record, and compliance. Ad placement is never for sale.
          </Notice>
        </ScrollReveal>
        <ScrollReveal direction="up" delay={120} className="h-full">
          <Notice tone="info" title="Chassis Inspection Scope" tag="Scope & Match" className="h-full">
            Reports document physical chassis condition, odometer photo, and VIN match at the time of inspection.
          </Notice>
        </ScrollReveal>
      </div>

      {data.inspectors.length === 0 ? (
        <EmptyState title="No verified workshops found">
          No workshops with an active capacity bond have cleared identity verification yet.
        </EmptyState>
      ) : (
        <ScrollReveal direction="up" delay={50} className="card overflow-hidden bg-white shadow-xs">
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  <th>Workshop Entity</th>
                  <th>Location</th>
                  <th>Capacity Bond</th>
                  <th>On-Time SLA</th>
                  <th>Standard Compliance</th>
                  <th>Median Time</th>
                  <th>Dispute Rate</th>
                  <th>Completed Deals</th>
                </tr>
              </thead>
              <tbody>
                {data.inspectors.map((entry, index) => (
                  <tr key={entry.actor.id} className="hover:bg-slate-50/80 transition-colors">
                    <td>
                      <span
                        className={`grid h-7 w-7 place-items-center rounded-lg text-xs font-bold ${
                          index === 0
                            ? 'bg-slate-900 text-white shadow-2xs'
                            : index === 1
                              ? 'bg-slate-800 text-white'
                              : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {index + 1}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-900 text-xs font-bold text-white shadow-2xs">
                          {entry.actor.displayName.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <div className="font-bold text-ink">{entry.actor.displayName}</div>
                          <div className="mt-0.5">
                            <Badge tone={entry.actor.verification === 'business_verified' ? 'ok' : 'neutral'}>
                              {entry.actor.verification === 'business_verified' ? 'Business Verified' : entry.actor.verification}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="text-sm font-medium text-body">
                      {entry.actor.city ?? '-'}, {entry.actor.countryCode}
                    </td>
                    <td className="tabular-nums font-bold text-emerald-800">
                      {formatAmount(entry.bond.amount, entry.bond.currency)}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1 font-bold tabular-nums text-ink">
                        {percent(entry.reputation?.onTimeReportRate ?? null)}
                      </span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1 font-bold tabular-nums text-ink">
                        {percent(entry.reputation?.standardComplianceRate ?? null)}
                      </span>
                    </td>
                    <td className="tabular-nums font-medium text-muted">
                      {entry.reputation?.medianReportHours !== null && entry.reputation?.medianReportHours !== undefined
                        ? `${entry.reputation.medianReportHours}h`
                        : '-'}
                    </td>
                    <td className="tabular-nums">
                      <span className="font-medium text-body">{entry.reputation?.disputesOpened ?? 0}</span>
                      {entry.reputation && entry.reputation.disputesLost > 0 ? (
                        <span className="ml-1 text-xs font-bold text-rose-700">
                          ({entry.reputation.disputesLost} lost)
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular-nums font-bold text-ink">
                      {entry.reputation?.dealsCompleted ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ScrollReveal>
      )}

      <ScrollReveal direction="up" delay={50}>
        <div className="card p-6 bg-slate-50 text-xs leading-relaxed text-muted space-y-2 border-slate-300">
          <div className="text-xs font-bold uppercase tracking-wider text-ink flex items-center gap-1.5">
            <Icon name="shield" className="h-4 w-4 text-slate-900" />
            <span>Ranking Policy &amp; SLA Transparency</span>
          </div>
          <p>{data.rankingPolicy}</p>
        </div>
      </ScrollReveal>
    </div>
  );
}
