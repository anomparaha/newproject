import { api } from '@/lib/api';
import { Badge, Notice, PageHeader } from '@/components/Chips';
import { Icon } from '@/components/Icons';
import { percent } from '@/lib/format';
import { ScrollReveal } from '@/components/ScrollReveal';
import { AnimatedMetric } from '@/components/AnimatedMetric';

export const dynamic = 'force-dynamic';

export default async function CorridorsPage() {
  const corridors = await api.corridors();

  if (!corridors) {
    return (
      <Notice tone="warn" title="API server is not responding">
        Run <code>npm run dev:api</code> to inspect trade corridor health.
      </Notice>
    );
  }

  const details = await Promise.all(
    corridors.corridors.map(async (corridor) => ({
      corridor,
      result: await api.corridorMetrics(corridor.id),
    })),
  );

  return (
    <div className="space-y-12">
      <ScrollReveal direction="up" delay={0}>
        <PageHeader
          eyebrow="Bilateral Trade Lanes"
          title="Cross-Border Corridors"
          description="The pilot corridor is deliberately narrow: verified origin registry, verified destination compliance, minimum valuation thresholds, and mandatory certified inspection before fund transfer."
        />
      </ScrollReveal>

      {details.map(({ corridor, result }) => (
        <section key={corridor.id} className="space-y-6">
          <ScrollReveal direction="up" delay={40}>
            <div className="card p-6 bg-white shadow-xs border-slate-300">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <span className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-900 text-white shadow-2xs">
                    <Icon name="globe" className="h-6 w-6" />
                  </span>
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-bold tracking-tight text-ink">
                        {corridor.originCountry} → {corridor.destinationCountry}
                      </h2>
                      <Badge tone={corridor.status === 'pilot' ? 'brand' : 'neutral'}>
                        {corridor.status.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted mt-1">
                      Minimum vehicle threshold: USD {corridor.minVehiclePriceUsd.toLocaleString('en-US')} · Currencies:{' '}
                      {corridor.allowedCurrencies.join(', ')}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-600 beacon-dot" />
                  <span className="text-xs font-bold text-emerald-800">Corridor SLA Active</span>
                </div>
              </div>
            </div>
          </ScrollReveal>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <AnimatedMetric
              label="Deals Completed"
              value={String(result?.metrics.dealsCompleted ?? 0)}
              icon="check"
              hint="Pilot milestone"
              delay={0}
            />
            <AnimatedMetric
              label="Median Report Time"
              value={
                result?.metrics.medianHoursToReport !== null && result?.metrics.medianHoursToReport !== undefined
                  ? `${result.metrics.medianHoursToReport}h`
                  : '-'
              }
              icon="report"
              hint="Workshop turnaround"
              delay={90}
            />
            <AnimatedMetric
              label="Dispute Rate"
              value={percent(result?.metrics.disputeRate ?? 0, 1)}
              icon="shield"
              hint="Safety metric"
              delay={180}
            />
            <AnimatedMetric
              label="Open Odometer Anomalies"
              value={String(result?.metrics.unexplainedOdometerAnomalies ?? 0)}
              icon="gauge"
              hint="Chassis anomaly tracker"
              delay={270}
            />
          </div>

          <ScrollReveal direction="up" delay={50} className="grid gap-6 lg:grid-cols-2">
            <div className="card p-6 bg-white space-y-4 shadow-xs">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <h3 className="text-base font-bold text-ink">Corridor Health Diagnostics</h3>
                <Badge tone={result?.halt.halted ? 'bad' : 'ok'}>
                  {result?.halt.halted ? 'Expansion Suspended' : 'Healthy Protocol State'}
                </Badge>
              </div>

              <ul className="divide-y divide-line text-sm">
                <li className="flex justify-between py-3">
                  <span className="text-body font-medium">Verified Sellers Returning</span>
                  <span className="font-bold tabular-nums text-ink">{percent(result?.metrics.sellerReturnRate ?? 0)}</span>
                </li>
                <li className="flex justify-between py-3">
                  <span className="text-body font-medium">Certified Workshops Returning</span>
                  <span className="font-bold tabular-nums text-ink">{percent(result?.metrics.inspectorReturnRate ?? 0)}</span>
                </li>
                <li className="flex items-center justify-between py-3">
                  <span className="text-body font-medium">Automatic Expansion Halted?</span>
                  <span className={`font-bold ${result?.halt.halted ? 'text-bad' : 'text-ok'}`}>
                    {result?.halt.halted ? 'Yes' : 'No (Passing Criteria)'}
                  </span>
                </li>
              </ul>

              {result?.halt.halted ? (
                <Notice tone="danger" title="Expansion Halt Trigger Active">
                  Reasons: {result.halt.reasons.join(', ')}
                </Notice>
              ) : (
                <Notice tone="safe" title="Prerequisites Satisfied">
                  Corridor demonstrates physical execution before new candidate trade lanes are unlocked.
                </Notice>
              )}
            </div>

            <div className="card p-6 bg-white space-y-4 shadow-xs">
              <h3 className="text-base font-bold text-ink">Regulatory Metric Scope</h3>
              <p className="text-sm leading-relaxed text-muted">
                Published metrics track physical reality: confirmed vehicle deliveries, turnaround SLA, and verified dispute
                frequencies.
              </p>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-body space-y-2">
                <div className="font-semibold text-ink">Strict Compliance Boundaries:</div>
                <p>
                  1. Odometer anomalies on any chassis remain strictly flagged as unexplained until an arbiter has formally
                  ruled on the evidence.
                </p>
                <p>
                  2. Price projections or promised token returns are legally prohibited from platform metrics.
                </p>
              </div>
            </div>
          </ScrollReveal>
        </section>
      ))}

      {/* Candidate corridors */}
      <ScrollReveal direction="up" delay={50} as="section" className="card p-6 sm:p-7 bg-white space-y-4 shadow-xs">
        <div>
          <h2 className="text-lg font-bold text-ink">Candidate Corridors (Awaiting Pilot Completion)</h2>
          <p className="text-xs text-muted mt-0.5">
            Trade lanes scheduled for evaluation once pilot metrics confirm steady physical throughput.
          </p>
        </div>

        <ul className="space-y-3 pt-2">
          {corridors.candidateCorridors.map((candidate) => (
            <li
              key={`${candidate.originCountry}-${candidate.destinationCountry}`}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 transition-all duration-200 hover:bg-slate-100 hover:border-slate-300"
            >
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-white border border-slate-200 text-muted shadow-2xs">
                  <Icon name="globe" className="h-4 w-4" />
                </span>
                <span className="font-bold text-ink text-sm sm:text-base">
                  {candidate.originCountry} → {candidate.destinationCountry}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted max-w-md">{candidate.reason}</span>
                <Badge tone="neutral">Queued</Badge>
              </div>
            </li>
          ))}
        </ul>
      </ScrollReveal>
    </div>
  );
}
